#!/bin/sh
# build + run every self-check (src/**/*.check.ts) and shell test (scripts/*.test.sh) in parallel; exit 1 if any fails
#   sh scripts/check.sh [--changed [base]] [--dry-run]
# --changed [base] (default origin/main): only the checks and tests the change reaches — base...HEAD plus uncommitted
# and untracked files — chosen by scripts/check-plan.mjs (import closures, named paths; when unsure, a job runs; a
# change to the check machinery, build.sh or CI runs everything). For after each edit; the full suite before a push.
# --dry-run: print the selection and the job queue, run nothing.
# Machine-wide limits (scripts/check-lock.sh; off on CI unless set): CHECK_MAX_SUITES suites at once (default 2), each
# waiting its turn, and CHECK_MAX_BUILDS scriptc builds (default cores/4, at most 6) across every worktree and agent.
# CHECK_JOBS: parallel jobs (default: CPU count). CHECK_SCRIPTC_FLAGS: check build flags (default: --optimization dev
# --strip: -O0 with cached object shards, same program behavior, about half the compile time; --strip skips macOS's
# dsymutil; empty for -O2; also used for the tests' own builds). A check with a "// check: timing" line (a timing budget) builds -O2 and runs alone after the others;
# a shell test with a "# check: timing" line (a latency bound) runs alone after the others too.
# On macOS CHECK_FFI (--ffi src/platform/darwin/ffi.json: the libproc bindings) goes into the bin and release builds and
# into every check with a "// check: ffi" line, those built with --backend c too (the darwin-x64 release's backend);
# libproc.c is also compiled once with -Wall -Wextra -Werror (job cc:<file>).
# On every OS CHECK_CRYPTO (--ffi src/features/team/crypto/ffi.json: Monocypher, the team crypto) goes into the bin and
# release builds and into every check with a "// check: crypto" line (on macOS built with --backend c too); agcrypto.c
# is compiled once with -Wall -Wextra -Werror (job cc:<file>).
# The shell tests share one agentglass, built here once, in parallel with the checks: AGENTGLASS_BIN uses a prebuilt one
# instead; else AGENTGLASS_OUT (default .scriptc/check/agentglass) with CHECK_BIN_FLAGS (default: the check flags).
# CHECK_RELEASE_OUT: also build the release binary (-O2, as shipped) there and smoke-test it, as one more job.
# CHECK_SHARD=<i>/<n> runs only shard i of n (CI splits each OS across runners), balanced by scripts/check-plan.mjs;
# shard 1 takes the shared binary and the tests that use it.
set -e
cd "$(dirname "$0")/.."
# never reach the developer's real herdr (checks run inside herdr panes): its variables are dropped for every job
HERDR_UNSET="-u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID -u HERDR_SOCKET_PATH -u HERDR_BIN_PATH -u HERDR_SESSION -u HERDR_PLUGIN_ID -u AGENTGLASS_HERDR_SOCKET"

# limit S cmd…: run cmd with stdin from /dev/null, kill it (and its children) after S seconds: a hang fails fast
limit() {
  s=$1; shift
  "$@" </dev/null 9>&- & p=$! # 9: the suite slot (scripts/check-lock.sh), not for jobs or what they leave running
  ( sleep "$s"; kill -0 "$p" 2>/dev/null || exit 0; echo "TIMEOUT after ${s}s: $*"; pkill -TERM -P "$p" 2>/dev/null; kill -TERM "$p" 2>/dev/null ) 2>/dev/null 9>&- & w=$! # quiet: killing its sleep must not print "Terminated" into the log
  wait "$p"; rc=$?
  pkill -P "$w" 2>/dev/null; wait "$w" 2>/dev/null # its sleep ends, the watchdog sees cmd gone and exits
  return $rc
}

run_test() { limit 600 env $HERDR_UNSET -u AGENTGLASS_CONFIG -u AGENTGLASS_RULES -u AGENTGLASS_CACHE_DIR -u AGENTGLASS_PRICES -u AGENTGLASS_FLEET_DIR -u AGENTGLASS_SSH -u AGENTGLASS_FLEET AGENTGLASS_HERDR=off sh "$1" >"$2" 2>&1; } # run_test <file> <log>
run_check() { # run_check <id> <executable> <log>: sets rc
  # hermetic: a fresh temp HOME/XDG per check and no agent-dir or agentglass path overrides from the caller, so no check
  # can read or write the user's real home (sessions, ~/.agentglass config, cache, run dir, palette, theme)
  h="$CHECK_OUT/$1.home"; mkdir -p "$h"; rc=0
  # (herdr: no HERDR_* of the developer's own pane and herdr off — a herdr check opts in with a fake binary and socket)
  limit 300 env $HERDR_UNSET -u GEMINI_CLI_HOME -u OPENCODE_DB -u PI_CODING_AGENT_DIR -u PI_CODING_AGENT_SESSION_DIR -u AGENTGLASS_CACHE_DIR \
    -u AGENTGLASS_CONFIG -u AGENTGLASS_RUN_DIR -u AGENTGLASS_PALETTE_FILE -u AGENTGLASS_OTLP_DIR -u AGENTGLASS_THEME -u AGENTGLASS_THEME_FILE -u AGENTGLASS_PRICES -u AGENTGLASS_FLEET_DIR -u AGENTGLASS_SSH -u AGENTGLASS_FLEET \
    AGENTGLASS_HERDR=off HOME="$h" XDG_CONFIG_HOME="$h/.config" XDG_DATA_HOME="$h/.local/share" XDG_STATE_HOME="$h/.local/state" \
    XDG_CACHE_HOME="$h/.cache" AGENTGLASS_HERMETIC=1 \
    AGENTGLASS_RULES=/nonexistent AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme "$2" >"$3" 2>&1 || rc=$?
  rm -rf "$h"
}

# summary <log>: the job's own last line; shell job-status lines a killed child leaves after it ("Terminated", bash's
# "x.sh: line 9: 123 Terminated  sleep 9", "Killed") and blank lines are skipped (the last line wins if all are noise)
summary() {
  awk '{ l = $0; sub(/^.*: line [0-9]+: +[0-9]+ +/, "", l) }
       !/^[[:space:]]*$/ && l !~ /^(Terminated|Killed|Hangup|Alarm clock|Interrupt)([: ].*)?$/ { s = $0 }
       NF { last = $0 } END { print (s != "" ? s : last) }' "$1"
}
if [ "${1:-}" = --summary ]; then summary "$2"; exit 0; fi

# one job (internal): bin, check:<file> or test:<file>; writes $CHECK_OUT/<id>.status ("<rc> <seconds>", rc 0, an exit
# code, "build", or "deferred": a timing check, built, to run alone after the pool) and $CHECK_OUT/<id>.log
if [ "${1:-}" = --job ]; then
  job=$2; id=$(printf %s "$job" | tr '/:.' '___'); log="$CHECK_OUT/$id.log"; rc=0; t0=$(date +%s)
  case "$job" in
    bin) scriptc build $CHECK_BIN_FLAGS $CHECK_CRYPTO $CHECK_FFI src/main.ts -o "$AGENTGLASS_BIN" >"$log" 2>&1 || rc=$?
         echo $rc > "$CHECK_OUT/bin.done" ;;
    release) # the release build (-O2, as shipped) and a smoke test of it
         { scriptc build $RELEASE_FLAGS $CHECK_CRYPTO $CHECK_FFI src/main.ts -o "$CHECK_RELEASE_OUT" && h="$CHECK_OUT/release.home" && mkdir -p "$h" &&
           HOME="$h" XDG_CONFIG_HOME="$h/.config" XDG_STATE_HOME="$h/.local/state" XDG_CACHE_HOME="$h/.cache" sh -c \
             '"$1" --version && "$1" --version --json && "$1" --json --limit 1 >/dev/null && echo "release build: smoke test ok"' _ "$CHECK_RELEASE_OUT" &&
           { [ -z "$CHECK_FFI" ] || { nm -u "$CHECK_RELEASE_OUT" | grep -q '_proc_listallpids' && echo "release build: libproc bound"; }; } &&
           { nm "$CHECK_RELEASE_OUT" | grep -q ' T _\{0,1\}ag_lock$' && echo "release build: team crypto linked"; }
         } >"$log" 2>&1 || rc=$? ;;
    check:*) f=${job#check:} # scriptc keys its cache on the output path: keep it stable. One directory per check: scriptc
         d="$PWD/.scriptc/check/$id"; mkdir -p "$d" # writes <source basename>.ll beside it, and basenames repeat
         fl=$CHECK_SCRIPTC_FLAGS; timing=""; if grep -q '^// check: timing' "$f"; then fl=""; timing=1; fi
         if [ -n "$CHECK_FFI" ] && grep -q '^// check: ffi' "$f"; then fl="$fl $CHECK_FFI --backend c"; fi
         if grep -q '^// check: crypto' "$f"; then fl="$fl $CHECK_CRYPTO"; [ -z "$CHECK_FFI" ] || case "$fl" in *"--backend c"*) ;; *) fl="$fl --backend c";; esac; fi
         if ! scriptc build $fl "$f" -o "$d/c" >"$log" 2>&1; then rc=build
         elif [ -n "$timing" ]; then rc=deferred # runs after the pool, alone
         else run_check "$id" "$d/c" "$log"; fi
         [ "$rc" = deferred ] || rm -rf "$d" ;; # a cache hit doesn't need the old executable
    cc:*) f=${job#cc:} # the FFI's C file, warnings as errors
         { cc -fsyntax-only -Wall -Wextra -Werror "$f" && echo "$f: no warnings"; } >"$log" 2>&1 || rc=$? ;;
    test:*) f=${job#test:}
         if grep -q AGENTGLASS_BIN "$f"; then # uses the shared binary: wait for the bin job (queued first, so already running)
           while [ ! -s "$CHECK_OUT/bin.done" ]; do sleep 0.2; done
           [ "$(cat "$CHECK_OUT/bin.done")" = 0 ] || { echo "skipped: agentglass build failed" > "$log"; rc=1; }
         fi
         # hermetic via their own temp HOME: no agentglass path overrides from the caller
         if [ $rc = 0 ] && grep -q '^# check: timing' "$f"; then rc=deferred # runs after the pool, alone
         else [ $rc != 0 ] || run_test "$f" "$log" || rc=$?; fi ;;
  esac
  echo "$rc $(($(date +%s) - t0))" > "$CHECK_OUT/$id.status"; exit 0
fi

usage() {
  cat <<'EOF'
usage: sh scripts/check.sh [--changed [base]] [--dry-run]
  every self-check (src/**/*.check.ts) and shell test (scripts/*.test.sh), in parallel; exit 1 if any fails
  --changed [base]  only what the change reaches: base...HEAD (default origin/main) plus uncommitted and untracked
                    files; after each edit. The full suite once before a push; CI runs everything
  --dry-run         print the selection and the job queue, run nothing
environment: CHECK_JOBS (parallel jobs), CHECK_MAX_SUITES / CHECK_MAX_BUILDS (machine-wide suites and scriptc builds
  at once, default 2 / cores/4 up to 6, 0: no limit, off on CI unless set; sh scripts/check-lock.sh status),
  CHECK_SHARD, CHECK_RELEASE_OUT, AGENTGLASS_BIN, CHECK_SCRIPTC_FLAGS (see the top of scripts/check.sh)
EOF
}
changed=""; base=origin/main; dry=""
while [ $# -gt 0 ]; do
  case "$1" in
    --changed) changed=1; case "${2:-}" in ''|-*) ;; *) base=$2; shift ;; esac ;;
    --dry-run) dry=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "check.sh: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
if [ -n "$changed" ] && ! git rev-parse -q --verify "$base^{commit}" >/dev/null 2>&1; then
  echo "check.sh --changed: no commit '$base' to compare with — git fetch origin, or name one: --changed <base>" >&2; exit 2
fi

. ./scripts/toolchain.sh
. ./scripts/check-lock.sh
start=$(date +%s)
# once, before any build (no job rewrites src/build-info.ts); the commit date, not now, keeps it byte-identical across
# runs on one commit, so unchanged checks are scriptc cache hits
AGENTGLASS_BUILD_DATE=${AGENTGLASS_BUILD_DATE:-$(TZ=UTC git log -1 --date=format-local:%Y-%m-%dT%H:%M:%SZ --format=%cd 2>/dev/null || true)}
export AGENTGLASS_BUILD_DATE; sh scripts/build-info.sh
jobs=${CHECK_JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}
CHECK_OUT=$(mktemp -d); trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; slot_drop; rm -rf "$CHECK_OUT"' EXIT
trap 'exit 130' INT; trap 'exit 143' TERM; LOCK_HELD=""
CHECK_SCRIPTC_FLAGS=${CHECK_SCRIPTC_FLAGS---optimization dev --strip}
RELEASE_FLAGS="${SCRIPTC_FLAGS:-}"; CHECK_BIN_FLAGS="${SCRIPTC_FLAGS:-} ${CHECK_BIN_FLAGS-$CHECK_SCRIPTC_FLAGS}"
SCRIPTC_FLAGS="${SCRIPTC_FLAGS:-} $CHECK_SCRIPTC_FLAGS" # the tests' own builds: build.sh honors SCRIPTC_FLAGS
CHECK_FFI=""; if [ "$(uname -s)" = Darwin ] && [ -f src/platform/darwin/ffi.json ]; then CHECK_FFI="--ffi $PWD/src/platform/darwin/ffi.json"; fi
CHECK_CRYPTO="--ffi $PWD/src/features/team/crypto/ffi.json"
export CHECK_OUT CHECK_SCRIPTC_FLAGS CHECK_BIN_FLAGS RELEASE_FLAGS SCRIPTC_FLAGS CHECK_FFI CHECK_CRYPTO PATH
rm -rf .scriptc/check; mkdir -p .scriptc/check
checks=$(find src -name '*.check.ts' | sort); tests=$(find scripts -name '*.test.sh' | sort)
shard=${CHECK_SHARD:-1/1}; si=${shard%/*}; sn=${shard#*/}
case "$si/$sn" in *[!0-9/]*|/*|*/) echo "CHECK_SHARD=$shard: want <i>/<n>" >&2; exit 1;; esac
[ "$si" -ge 1 ] && [ "$si" -le "$sn" ] || { echo "CHECK_SHARD=$shard: want 1 <= i <= n" >&2; exit 1; }
if [ -n "${AGENTGLASS_BIN:-}" ]; then
  [ -f "$AGENTGLASS_BIN" ] && [ -x "$AGENTGLASS_BIN" ] || { echo "AGENTGLASS_BIN=$AGENTGLASS_BIN is not an executable" >&2; exit 1; }
  AGENTGLASS_BIN=$(cd "$(dirname "$AGENTGLASS_BIN")" && pwd)/$(basename "$AGENTGLASS_BIN"); echo 0 > "$CHECK_OUT/bin.done"; bin=""
else # a stable path: scriptc keys its cache on it
  AGENTGLASS_BIN=${AGENTGLASS_OUT:-.scriptc/check/agentglass}; case "$AGENTGLASS_BIN" in /*) ;; *) AGENTGLASS_BIN="$PWD/$AGENTGLASS_BIN";; esac; bin=bin
fi
export AGENTGLASS_BIN

# this shard's jobs, heaviest first (scripts/check-plan.mjs); xargs starts them in that order, the shared binary first
if [ -n "${CHECK_RELEASE_OUT:-}" ]; then
  case "$CHECK_RELEASE_OUT" in /*) ;; *) CHECK_RELEASE_OUT="$PWD/$CHECK_RELEASE_OUT";; esac; export CHECK_RELEASE_OUT
fi
all="$([ -z "$bin" ] || echo bin) $([ -z "${CHECK_RELEASE_OUT:-}" ] || echo release)"
all="$all $(for f in $tests; do echo "test:$f"; done) $(for f in $checks; do echo "check:$f"; done)"
[ -z "$CHECK_FFI" ] || all="$all cc:src/platform/darwin/libproc.c"
all="$all cc:src/features/team/crypto/agcrypto.c"
if [ -n "$changed" ]; then # keep the jobs the change reaches; say which and why
  # each git must succeed: a failed diff (no merge base, a shallow clone) must not shrink the selection
  git diff --name-only --no-renames "$base...HEAD" > "$CHECK_OUT/changed" ||
    { echo "check.sh --changed: no diff against '$base' (no common history? git fetch --unshallow origin)" >&2; exit 2; }
  { git diff --name-only --no-renames HEAD && git ls-files --others --exclude-standard; } >> "$CHECK_OUT/changed" ||
    { echo "check.sh --changed: git cannot list the uncommitted changes" >&2; exit 2; }
  sort -u -o "$CHECK_OUT/changed" "$CHECK_OUT/changed"
  nf=$(grep -c . "$CHECK_OUT/changed" || true); nc=$(echo "$checks" | grep -c .); nt=$(echo "$tests" | grep -c .)
  if [ "$nf" = 0 ]; then echo "--changed $base: nothing changed: nothing to run"; exit 0; fi
  echo "--changed $base: $nf changed: $(head -5 "$CHECK_OUT/changed" | paste -sd' ' -)$([ "$nf" -le 5 ] || echo " …")"
  node scripts/check-plan.mjs --changed "$CHECK_OUT/changed" $all > "$CHECK_OUT/picked"
  if grep -q '^ALL	' "$CHECK_OUT/picked"; then echo "  full suite: $(cut -f2 "$CHECK_OUT/picked")"
  else # one line per reason: the job itself when alone, else how many and the first few
    awk -F'\t' '$1 ~ /^(check|test):/ { k = substr($1, 1, index($1, ":") - 1); f = substr($1, index($1, ":") + 1)
           if (!($2 in n)) o[++m] = $2; n[$2]++; kind[$2] = k; one[$2] = f; b = f; sub(/.*\//, "", b); if (n[$2] <= 3) l[$2] = l[$2] (n[$2] > 1 ? ", " : "") b }
         END { for (i = 1; i <= m; i++) { r = o[i]
                 if (n[r] == 1) printf "  %-5s %s: %s\n", kind[r], one[r], r
                 else printf "  %d %ss: %s (%s%s)\n", n[r], kind[r], r, l[r], (n[r] > 3 ? ", …" : "") } }' "$CHECK_OUT/picked"
    all=$(cut -f1 "$CHECK_OUT/picked")
    echo "--changed: $(echo "$all" | grep -c '^check:') of $nc checks, $(echo "$all" | grep -c '^test:') of $nt tests"
    if [ -z "$all" ]; then echo "--changed: nothing to run (no check or test reads what changed)"; exit 0; fi
  fi
fi
node scripts/check-plan.mjs "$si" "$sn" $all > "$CHECK_OUT/queue"
if [ -n "$dry" ]; then echo "would run (shard $si/$sn):"; cat "$CHECK_OUT/queue"; exit 0; fi
# the machine-wide limits: this suite's slot (waits its turn), and every scriptc — the jobs', and the tests' own via
# build.sh or scriptc build — through a shim on PATH that takes a build slot
lock_init; export CHECK_LOCK_WHO="$LOCK_WHO" CHECK_LOCK_DIR="$LOCK_DIR" CHECK_LOCK_WAITS="$CHECK_OUT/waits"
swait=$(date +%s); LOCK_WAITED=""
if [ -z "${CHECK_LOCK_SUITE_HELD:-}" ]; then slot_take suite "$LOCK_SUITES"; export CHECK_LOCK_SUITE_HELD=1; fi
swait=$([ -z "$LOCK_WAITED" ] || echo $(($(date +%s) - swait)))
if [ "$LOCK_BUILDS" -gt 0 ] && [ -z "${CHECK_LOCK_IN_BUILD:-}" ]; then
  # the real scriptc, also in a check.sh a test runs (whose PATH has this shim first)
  CHECK_LOCK_SCRIPTC=${CHECK_LOCK_SCRIPTC:-$(command -v scriptc)}; export CHECK_LOCK_SCRIPTC
  q() { printf "'%s'" "$(printf %s "$1" | sed "s/'/'\\\\''/g")"; } # single-quoted for sh
  mkdir "$CHECK_OUT/shim"
  printf '#!/bin/sh\nexec sh %s run build %s "$@"\n' "$(q "$PWD/scripts/check-lock.sh")" "$(q "$CHECK_LOCK_SCRIPTC")" > "$CHECK_OUT/shim/scriptc"
  chmod +x "$CHECK_OUT/shim/scriptc"; PATH="$CHECK_OUT/shim:$PATH"
fi
grep -qx bin "$CHECK_OUT/queue" || bin="" # on another shard
grep -qx release "$CHECK_OUT/queue" && release=1 || release=""
xargs -n 1 -P "$jobs" sh scripts/check.sh --job < "$CHECK_OUT/queue" 9>&-
for j in $(grep -E '^(check|test):' "$CHECK_OUT/queue"); do # the timing checks and tests, one at a time on an idle machine
  id=$(printf %s "$j" | tr '/:.' '___'); set -- $(cat "$CHECK_OUT/$id.status")
  if [ "$1" = deferred ]; then
    t0=$(date +%s)
    case "$j" in
      check:*) run_check "$id" "$PWD/.scriptc/check/$id/c" "$CHECK_OUT/$id.log"; rm -rf ".scriptc/check/$id" ;;
      test:*) rc=0; run_test "${j#test:}" "$CHECK_OUT/$id.log" || rc=$? ;;
    esac
    echo "$rc $(($2 + $(date +%s) - t0))" > "$CHECK_OUT/$id.status"
  fi
done

# report in a fixed order (checks, then tests), whatever order the jobs finished in
fail=0
report() { # report <job> <file>
  id=$(printf %s "$1" | tr '/:.' '___'); set -- "$1" "$2" $(cat "$CHECK_OUT/$id.status" 2>/dev/null || echo missing "?"); rc=$3
  if [ "$rc" = 0 ]; then echo "ok   $2 ($4 s): $(summary "$CHECK_OUT/$id.log")"
  elif [ "$rc" = build ]; then echo "BUILD FAIL $2 ($4 s)"; cat "$CHECK_OUT/$id.log"; fail=1
  else echo "FAIL $2 (exit $rc, $4 s)"; cat "$CHECK_OUT/$id.log" 2>/dev/null || true; fail=1; fi
}
if [ -n "$bin" ]; then
  if [ "$(cat "$CHECK_OUT/bin.done" 2>/dev/null)" = 0 ]; then echo "ok   src/main.ts ($(cut -d' ' -f2 "$CHECK_OUT/bin.status") s): built $AGENTGLASS_BIN"
  else echo "BUILD FAIL src/main.ts"; cat "$CHECK_OUT/bin.log"; fail=1; fi
fi
if [ -n "$release" ]; then report release "src/main.ts -O2 -> $CHECK_RELEASE_OUT"; fi
for f in $checks; do if grep -qxF "check:$f" "$CHECK_OUT/queue"; then report "check:$f" "$f"; fi; done
for j in $(grep '^cc:' "$CHECK_OUT/queue"); do report "$j" "${j#cc:} (cc -Wall -Wextra -Werror)"; done
for f in $tests; do if grep -qxF "test:$f" "$CHECK_OUT/queue"; then report "test:$f" "$f"; fi; done
if [ -s "$CHECK_OUT/waits" ]; then # how long the machine-wide build limit held this suite's builds back
  awk -v m="$LOCK_BUILDS" '{ n++; s += $2 } END { printf "build slots: %d builds waited %d s in all (CHECK_MAX_BUILDS=%d)\n", n, s, m }' "$CHECK_OUT/waits"
fi
[ -z "$swait" ] || echo "check slot: waited $swait s for a free suite slot (CHECK_MAX_SUITES=$LOCK_SUITES)"
echo "$(grep -c '^check:' "$CHECK_OUT/queue") checks, $(grep -c '^test:' "$CHECK_OUT/queue") tests (shard $si/$sn$([ -z "$changed" ] || echo ", --changed $base")), $jobs jobs, $(($(date +%s) - start)) s"
exit $fail
