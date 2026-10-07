#!/bin/sh
# tests for check-lock.sh (the machine-wide check slots), both implementations (flock where it exists, else symlinks):
# at most N holders at once, waiters wait (once-printed message naming the holders) and never fail, stale slots (dead
# pid, reused pid) are reclaimed, suites holding suite slots while their builds wait for build slots never deadlock,
# nested takes pass through, and CI turns the limit off unless set: sh scripts/check-lock.test.sh
here=$(cd "$(dirname "$0")" && pwd); t=$(mktemp -d); trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; rm -rf "$t"' EXIT
# not the slots of the check.sh running this test, nor its settings
unset CHECK_LOCK_SUITE_HELD CHECK_LOCK_IN_BUILD CHECK_LOCK_WAITS CHECK_LOCK_DIR CHECK_LOCK_WHO CHECK_LOCK_IMPL CHECK_MAX_SUITES CHECK_MAX_BUILDS
fail=0; L="$here/check-lock.sh"
bad() { echo "FAIL $*"; fail=1; }
# within S cmd…: cmd must finish within S seconds (a deadlock or a stuck waiter fails the test, never hangs it); on
# timeout cmd and its children (by parent pid) are stopped
within() {
  _s=$1; shift; "$@" & _p=$!; _n=0
  while kill -0 "$_p" 2>/dev/null; do
    sleep 0.1; _n=$((_n + 1)); [ $_n -lt $((_s * 10)) ] || { pkill -TERM -P "$_p"; kill -TERM "$_p"; wait "$_p"; return 124; } 2>/dev/null
  done
  wait "$_p"
}
# lk <impl> [VAR=value…] <args>…: check-lock.sh with that implementation, a fresh lock dir per impl, no CI, a fast
# poll (the variables go through env: an assignment before a shell function call is not portable)
lk() {
  _i=$1; shift; _a=""; while case "${1:-}" in *=*) true;; *) false;; esac; do _a="$_a $1"; shift; done
  env -u CI -u CHECK_LOCK_SUITE_HELD -u CHECK_LOCK_IN_BUILD CHECK_LOCK_IMPL=$_i CHECK_LOCK_DIR="$t/$_i/locks" \
    CHECK_LOCK_POLL=0.1 CHECK_LOCK_WHO="wt-$_i" $_a sh "$L" "$@"
}
# held <dir> <impl>: wait (up to 10 s) until a suite slot in that lock dir is taken: a slow runner starts holders late
held() { _n=0; until env -u CI CHECK_LOCK_DIR="$1" CHECK_LOCK_IMPL="$2" sh "$L" status | grep -q '^suite\.'; do
  sleep 0.1; _n=$((_n + 1)); [ $_n -lt 100 ] || { bad "no holder appeared in $1"; return 1; }; done; }
# a job that records how many jobs hold a slot at once: count the live markers, keep the peak
cat > "$t/job.sh" <<'EOF'
d=$1; : > "$d/on.$$"; n=$(ls "$d" | grep -c '^on\.'); echo "$n" >> "$d/peak"; sleep "${2:-0.4}"; rm -f "$d/on.$$"; echo done >> "$d/done"
EOF
peak() { sort -n "$1/peak" | tail -1; }

impls="link"; command -v flock >/dev/null 2>&1 && impls="flock link"
for i in $impls; do
  mkdir -p "$t/$i/c1" "$t/$i/c2" "$t/$i/c3" "$t/$i/c4"

  # concurrency: 5 suites, 2 slots -> never more than 2 at once, all 5 finish, each waiter says so exactly once
  for k in 1 2 3 4 5; do within 15 lk $i CHECK_MAX_SUITES=2 run suite sh "$t/job.sh" "$t/$i/c1" 2>"$t/$i/err.$k" & done; wait
  [ "$(peak "$t/$i/c1")" = 2 ] || bad "$i concurrency: peak $(peak "$t/$i/c1") holders, want 2"
  [ "$(wc -l < "$t/$i/c1/done")" -eq 5 ] || bad "$i concurrency: $(wc -l < "$t/$i/c1/done") of 5 finished"
  w=$(cat "$t/$i"/err.* | grep -c 'waiting for a check slot')
  [ "$w" -ge 1 ] && [ "$w" -le 3 ] || bad "$i concurrency: $w waiting messages, want 1..3 (one per waiter)"
  for k in 1 2 3 4 5; do [ "$(grep -c waiting "$t/$i/err.$k")" -le 1 ] || bad "$i: waiter $k printed its message twice"; done
  grep -q "waiting for a check slot (2 running: wt-$i, wt-$i)" "$t/$i"/err.* || bad "$i: message names the holders: $(cat "$t/$i"/err.*)"

  # builds: the same limit with CHECK_MAX_BUILDS, silent while waiting (scriptc's own output must stay clean)
  for k in 1 2 3 4; do within 15 lk $i CHECK_MAX_BUILDS=3 run build sh "$t/job.sh" "$t/$i/c2" 0.3 2>"$t/$i/berr.$k" & done; wait
  [ "$(peak "$t/$i/c2")" = 3 ] || bad "$i builds: peak $(peak "$t/$i/c2"), want 3"
  [ -z "$(cat "$t/$i"/berr.*)" ] || bad "$i builds: printed while waiting: $(cat "$t/$i"/berr.*)"

  # the exit code of the command comes through, and its slot is freed
  within 5 lk $i CHECK_MAX_SUITES=1 run suite sh -c 'exit 7'; [ $? = 7 ] || bad "$i: exit code not passed through"
  within 3 lk $i CHECK_MAX_SUITES=1 run suite true || bad "$i: slot not freed after a failing command"

  # no deadlock: 4 suites, 2 suite slots, 1 build slot, each suite runs 3 builds in parallel (the shape of check.sh:
  # a suite slot held while its jobs wait for build slots); and a nested take of either kind passes straight through
  cat > "$t/suite.sh" <<EOF
for b in 1 2 3; do sh "$L" run build sh "$t/job.sh" "$t/$i/c3" 0.1 & done; wait
sh "$L" run suite true && sh "$L" run build sh "$L" run build true && echo nested-ok >> "$t/$i/nested"
EOF
  for k in 1 2 3 4; do within 20 lk $i CHECK_MAX_SUITES=2 CHECK_MAX_BUILDS=1 run suite sh "$t/suite.sh" 2>/dev/null & done; wait
  [ "$(wc -l < "$t/$i/c3/done" 2>/dev/null)" -eq 12 ] || bad "$i deadlock: $(wc -l < "$t/$i/c3/done" 2>/dev/null) of 12 builds finished"
  [ "$(peak "$t/$i/c3")" = 1 ] || bad "$i deadlock: build peak $(peak "$t/$i/c3"), want 1"
  [ "$(wc -l < "$t/$i/nested" 2>/dev/null)" -eq 4 ] || bad "$i: nested takes did not pass through"

  # a held slot blocks (a live holder is never reclaimed), its release lets the waiter in
  within 15 lk $i CHECK_MAX_SUITES=1 run suite sleep 1.5 & h=$!; held "$t/$i/locks" $i
  s0=$(date +%s); within 15 lk $i CHECK_MAX_SUITES=1 run suite true 2>/dev/null || bad "$i: waiter never got the freed slot"
  [ $(($(date +%s) - s0)) -ge 1 ] || bad "$i: a live holder's slot was taken"
  wait $h

  # a holder killed with SIGKILL (no cleanup) leaves no lasting slot (env execs sh: $! is the holder itself)
  env -u CI CHECK_LOCK_IMPL=$i CHECK_LOCK_DIR="$t/$i/locks" CHECK_MAX_SUITES=1 sh "$L" run suite sh -c 'echo $$ > "$1"; exec sleep 30' _ "$t/$i/orphan" & h=$!
  held "$t/$i/locks" $i; kill -9 $h; wait $h 2>/dev/null
  within 4 lk $i CHECK_MAX_SUITES=1 run suite true 2>/dev/null || bad "$i: the SIGKILLed holder's slot was not reclaimed"
  kill "$(cat "$t/$i/orphan")" 2>/dev/null # its orphaned sleep, by its own pid

  # status lists the held slots
  within 15 lk $i CHECK_MAX_SUITES=1 run suite sleep 1 2>/dev/null & h=$!; held "$t/$i/locks" $i
  lk $i status | grep -q "suite.1 .*wt-$i" || bad "$i status: $(lk $i status)"
  wait $h
done

# link: stale slots — a dead pid, and a live pid with another start time (pid reuse) — are reclaimed
d="$t/stale/locks"; mkdir -p "$d"
# racing reclaimers of one dead slot never both get it: 6 at once, 1 slot, 5 rounds -> never 2 holders
for r in 1 2 3 4 5; do
  mkdir -p "$t/race/c$r"; ln -s "999999|Thu Jan  1 00:00:00 1970|wt-dead" "$d/suite.1"
  for k in 1 2 3 4 5 6; do
    within 15 env -u CI CHECK_LOCK_IMPL=link CHECK_LOCK_DIR="$d" CHECK_LOCK_POLL=0.05 CHECK_MAX_SUITES=1 sh "$L" run suite sh "$t/job.sh" "$t/race/c$r" 0.05 2>/dev/null &
  done; wait
  [ "$(peak "$t/race/c$r")" = 1 ] && [ "$(wc -l < "$t/race/c$r/done")" -eq 6 ] || bad "reclaim race $r: peak $(peak "$t/race/c$r"), $(wc -l < "$t/race/c$r/done") of 6 done"
done
# a holder that frees its slot looks dead to a waiter that read it a moment before; under load (a slow ps) that waiter
# must not remove the slot another took meanwhile: 12 waiters, 1 slot, short holds -> never 2 holders
mkdir -p "$t/slow"; printf '#!/bin/sh\nsleep 0.0$(od -An -N1 -tu1 /dev/urandom | tr -d " " | cut -c1)\nexec %s "$@"\n' "$(command -v ps)" > "$t/slow/ps"
chmod +x "$t/slow/ps"; d="$t/release/locks"; mkdir -p "$d"
for r in 1 2 3; do
  mkdir -p "$t/release/c$r"
  for k in 1 2 3 4 5 6 7 8 9 10 11 12; do
    within 30 env -u CI PATH="$t/slow:$PATH" CHECK_LOCK_IMPL=link CHECK_LOCK_DIR="$d" CHECK_LOCK_POLL=0.01 CHECK_MAX_SUITES=1 sh "$L" run suite sh "$t/job.sh" "$t/release/c$r" 0.02 2>/dev/null &
  done; wait
  [ "$(peak "$t/release/c$r")" = 1 ] && [ "$(wc -l < "$t/release/c$r/done")" -eq 12 ] || bad "release race $r: peak $(peak "$t/release/c$r"), $(wc -l < "$t/release/c$r/done") of 12 done"
done
[ -z "$(ls -A "$d")" ] || bad "release race: left behind: $(ls -A "$d")"
sleep 30 & live=$!
for tk in "999999|Thu Jan  1 00:00:00 1970|wt-dead" "$live|Thu Jan  1 00:00:00 1970|wt-reused"; do
  ln -s "$tk" "$d/suite.1"
  within 3 env -u CI CHECK_LOCK_IMPL=link CHECK_LOCK_DIR="$d" CHECK_LOCK_POLL=0.1 CHECK_MAX_SUITES=1 sh "$L" run suite sh -c 'readlink "$1/suite.1" > "$2"' _ "$d" "$t/stale/n" 2>"$t/stale/err" ||
    bad "stale slot ${tk##*|} not reclaimed: $(cat "$t/stale/err")"
  case "$(cat "$t/stale/n" 2>/dev/null)" in "${tk##*|}"|*"|${tk##*|}") bad "stale: ${tk##*|} still held";; *'|'*) ;; *) bad "stale: not taken: $(cat "$t/stale/n" 2>/dev/null)";; esac
  [ -z "$(ls -A "$d")" ] || bad "stale: left behind: $(ls -A "$d")"
done
# a reclaimer that died inside its guard leaves the guard: cleared, the stale slot still reclaimed
ln -s "999999|Thu Jan  1 00:00:00 1970|wt-dead" "$d/suite.1"; ln -s "999998|Thu Jan  1 00:00:00 1970|reap" "$d/.reap.suite.1"
within 3 env -u CI CHECK_LOCK_IMPL=link CHECK_LOCK_DIR="$d" CHECK_LOCK_POLL=0.1 CHECK_MAX_SUITES=1 sh "$L" run suite true 2>/dev/null ||
  bad "stale guard: the slot was never reclaimed"
[ -z "$(ls -A "$d")" ] || bad "stale guard: left behind: $(ls -A "$d")"
# ... but a live pid with its own start time holds
ln -s "$live|$(LC_ALL=C ps -o lstart= -p $live | tr -s ' ' | sed 's/^ //;s/ $//')|wt-live" "$d/suite.1"
within 1 env -u CI CHECK_LOCK_IMPL=link CHECK_LOCK_DIR="$d" CHECK_LOCK_POLL=0.1 CHECK_MAX_SUITES=1 sh "$L" run suite true 2>"$t/stale/err2"
[ $? = 124 ] || bad "stale: a live holder's slot was reclaimed"
grep -q "1 running: wt-live" "$t/stale/err2" || bad "stale: message: $(cat "$t/stale/err2")"
kill $live; wait $live 2>/dev/null; rm -f "$d/suite.1"

# CI: off by default (a held slot does not block), on when the limit is set explicitly; the holder outlives the
# generous bounds below, so passing one means not waiting for it
d="$t/ci/locks"; mkdir -p "$d"
env -u CI CHECK_LOCK_IMPL=link CHECK_LOCK_DIR="$d" CHECK_MAX_SUITES=1 sh "$L" run suite sh -c 'echo $$ > "$1"; exec sleep 20' _ "$t/ci/holder" 2>/dev/null & h=$!; held "$d" link
within 5 env CI=true CHECK_LOCK_IMPL=link CHECK_LOCK_DIR="$d" CHECK_LOCK_POLL=0.1 sh "$L" run suite true || bad "CI: the limit applied without being set"
within 1 env CI=true CHECK_LOCK_IMPL=link CHECK_LOCK_DIR="$d" CHECK_LOCK_POLL=0.1 CHECK_MAX_SUITES=1 sh "$L" run suite true 2>/dev/null
[ $? = 124 ] || bad "CI: an explicit CHECK_MAX_SUITES was ignored"
# 0 means no limit; garbage is refused with the fix
within 5 env -u CI CHECK_LOCK_IMPL=link CHECK_LOCK_DIR="$d" CHECK_MAX_SUITES=0 sh "$L" run suite true || bad "CHECK_MAX_SUITES=0 still limited"
kill "$(cat "$t/ci/holder")"; wait $h 2>/dev/null
out=$(CHECK_LOCK_DIR="$d" CHECK_MAX_BUILDS=lots sh "$L" run build true 2>&1); rc=$?
[ $rc = 2 ] && echo "$out" | grep -q 'CHECK_MAX_BUILDS=lots' || bad "bad limit: rc $rc: $out"

# a lock directory that cannot be made: no limit, said once, never a hang
: > "$t/file"
out=$(within 5 env -u CI CHECK_LOCK_DIR="$t/file/locks" CHECK_MAX_SUITES=1 sh "$L" run suite echo ran 2>&1) || bad "unwritable lock dir: $out"
case "$out" in *"cannot write"*ran) ;; *) bad "unwritable lock dir: $out";; esac

# flock: a slot file that cannot be opened (another user's, mode 000) neither ends the suite nor waits forever
if command -v flock >/dev/null 2>&1 && [ "$(id -u)" != 0 ]; then
  d="$t/ro/locks"; mkdir -p "$d"; : > "$d/suite.1"; chmod 000 "$d/suite.1"
  out=$(within 5 env -u CI CHECK_LOCK_IMPL=flock CHECK_LOCK_DIR="$d" CHECK_MAX_SUITES=1 sh "$L" run suite echo ran 2>&1) || bad "unopenable slot: $out"
  case "$out" in *"cannot open"*ran) ;; *) bad "unopenable slot: $out";; esac
fi
# the other implementation's slot (a file system that changed, CHECK_LOCK_IMPL): free -> taken, held -> waited for
d="$t/mixed/locks"; mkdir -p "$d"; ln -s "999999|Thu Jan  1 00:00:00 1970|wt-dead" "$d/suite.1"
for i in $impls; do
  [ $i = link ] && { rm -f "$d/suite.1"; : > "$d/suite.1"; } # a flock file no one holds
  within 3 env -u CI CHECK_LOCK_IMPL=$i CHECK_LOCK_DIR="$d" CHECK_LOCK_POLL=0.1 CHECK_MAX_SUITES=1 sh "$L" run suite true 2>/dev/null ||
    bad "$i: the other implementation's free slot was never taken"
  rm -f "$d/suite.1"
done
if [ "$impls" = "flock link" ]; then
  env -u CI CHECK_LOCK_IMPL=flock CHECK_LOCK_DIR="$d" CHECK_MAX_SUITES=1 sh "$L" run suite sh -c 'echo $$ > "$1"; exec sleep 20' _ "$t/mixed/holder" 2>/dev/null & h=$!; held "$d" flock
  within 1 env -u CI CHECK_LOCK_IMPL=link CHECK_LOCK_DIR="$d" CHECK_LOCK_POLL=0.1 CHECK_MAX_SUITES=1 sh "$L" run suite true 2>/dev/null
  [ $? = 124 ] || bad "link: a held flock slot was taken"
  kill "$(cat "$t/mixed/holder")"; wait $h 2>/dev/null
fi

[ $fail = 0 ] && echo "check lock: all tests passed"
exit $fail
