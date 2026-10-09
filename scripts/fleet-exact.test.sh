#!/bin/sh
# agentglass fleet exactness end to end: three snapshot hosts in three time zones plus this machine hold overlapping
# copies of Claude messages (earlier, later and tied copies, an hour edge, a model only the viewer prices); fleet totals
# must equal one machine in the viewer's zone, with the viewer's prices, reading every log: sh scripts/fleet-exact.test.sh
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR AGENTGLASS_REDACT AGENTGLASS_FLEET_DIR AGENTGLASS_RUN_DIR AGENTGLASS_SSH AGENTGLASS_FLEET AGENTGLASS_PRICES # hermetic
export AGENTGLASS_AGENT=0
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
mkdir -p "$t/bin"
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/bin/agentglass"; else AGENTGLASS_OUT="$t/bin/agentglass" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
# UTC midnight of today (jq: portable date arithmetic); messages sit on the last three days, two of them at 22:30 UTC
# (another local day in Berlin and Tokyo, the same one in New York)
d0=$(jq -nr 'now / 86400 | floor * 86400')
ts() { jq -nr --argjson s "$(( d0 + $1 ))" '$s | todate | sub("Z$"; ".000Z")'; } # ts <seconds from today 00:00 UTC>
# home <name> <host id> <tz>
home() { mkdir -p "$t/$1/.claude/projects" "$t/$1/.agentglass"; printf '{"apiKeyHelper":"/bin/true"}\n' > "$t/$1/.claude/settings.json"; printf '%s\n' "$2" > "$t/$1/.agentglass/host-id"; printf '%s\n' "$3" > "$t/$1/tz"; }
# msg <home> <session> <message id> <seconds> <model> <in> <out> <cache read> <write 5m> <write 1h>: one assistant line
msg() {
  p="$t/$1/.claude/projects/-w-$2"; f="$p/$2.jsonl"; mkdir -p "$p"
  [ -f "$f" ] || printf '{"type":"user","sessionId":"%s","cwd":"/w/%s","timestamp":"%s","message":{"role":"user","content":"task %s"}}\n' "$2" "$2" "$(ts "$4")" "$2" > "$f"
  printf '{"type":"assistant","sessionId":"%s","cwd":"/w/%s","timestamp":"%s","message":{"id":"%s","role":"assistant","model":"%s","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":%s,"output_tokens":%s,"cache_read_input_tokens":%s,"cache_creation_input_tokens":%s,"cache_creation":{"ephemeral_5m_input_tokens":%s,"ephemeral_1h_input_tokens":%s}}}}\n' \
    "$2" "$2" "$(ts "$4")" "$3" "$5" "$6" "$7" "$8" "$(( $9 + ${10} ))" "$9" "${10}" >> "$f"
}
S=claude-sonnet-4-5; O=claude-opus-4-1; Z=claude-zeta-9 # Z: no built-in price; the viewer prices it
home h1 1111111111111111 Europe/Berlin
home h2 2222222222222222 UTC
home h3 3333333333333333 America/New_York
home h4 4444444444444444 Asia/Tokyo
D=86400; E=$(( 22 * 3600 + 1800 )) # 22:30 UTC
# h2: the originals of m1–m3 (two days ago at 22:30, yesterday, today)
msg h2 a1 m1 $(( E - 2 * D )) $S 1000 200 5000 300 0
msg h2 a1 m2 $(( 3600 - D )) $O 2000 400 0 0 700
msg h2 a1 m3 120 $S 3000 600 9000 0 0
msg h2 a2 m6 $(( E - D )) $Z 4000 800 0 0 0
# h3: later copies of m2 and m3 plus its own m4; an earlier copy of m1 in another session (h3 owns m1, h2's copy loses)
msg h3 b1 m2 $(( 7200 - D )) $O 2000 400 0 0 700
msg h3 b1 m3 600 $S 3000 600 9000 0 0
msg h3 b1 m4 900 $S 500 100 0 0 0
msg h3 b2 m1 $(( E - 2 * D - 60 )) $S 1000 200 5000 300 0
# h4: m4 at the same moment as h3's (a tie: the smaller host id owns it), a later copy of m6, its own m5
msg h4 c1 m4 900 $S 500 100 0 0 0
msg h4 c1 m6 $(( E - D + 30 )) $Z 4000 800 0 0 0
msg h4 c1 m5 1800 $O 700 70 0 0 0
# this machine: an earlier copy of m5 (it owns it: h4's loses) and a later copy of m3 (it loses: a correction)
msg h1 v1 m5 1700 $O 700 70 0 0 0
msg h1 v1 m3 1200 $S 3000 600 9000 0 0
msg h1 v1 m7 1300 $S 50 5 0 0 0
# the viewer's prices: claude-zeta-9 priced, claude-sonnet-4-5 overridden (the hosts keep their built-in table)
cat > "$t/ssh" <<'SH'
#!/bin/sh
[ "$1" = -V ] && { echo "fake ssh" >&2; exit 0; }
while [ $# -gt 0 ]; do case "$1" in -o|-O) shift 2;; -T) shift;; --) shift; break;; *) break;; esac; done
dest=$1; shift
unset AGENTGLASS_PRICES AGENTGLASS_FLEET_DIR AGENTGLASS_RUN_DIR # a host: its own (built-in) price table, its own peer state
case "$dest" in cut-*) dest=${dest#cut-}; TZ=$(cat "$FAKE_HOMES/$dest/tz") HOME="$FAKE_HOMES/$dest" eval "$*" | sed '$d'; exit 0 ;; esac # a connection cut before the end line
TZ=$(cat "$FAKE_HOMES/$dest/tz") HOME="$FAKE_HOMES/$dest" eval "$*"
SH
chmod +x "$t/ssh"
export FAKE_HOMES="$t" AGENTGLASS_SSH="$t/ssh" PATH="$t/bin:$PATH"
mkdir -p "$t/run"; chmod 700 "$t/run"
run() { TZ=Europe/Berlin HOME="$t/h1" AGENTGLASS_PRICES="$t/prices.json" AGENTGLASS_OFFLINE=1 AGENTGLASS_NOTIFY=0 AGENTGLASS_FLEET_DIR="$t/spool" AGENTGLASS_RUN_DIR="$t/run" "$t/bin/agentglass" "$@"; }
run prices set "$Z" --in 2 --out 8 > /dev/null; run prices set "$S" --in 5 --out 20 > /dev/null
# the truth: one machine in the viewer's zone with the viewer's prices holding every log
mkdir -p "$t/all/.claude/projects" "$t/all/.agentglass"; cp "$t/h1/.claude/settings.json" "$t/all/.claude/"
for h in h1 h2 h3 h4; do cp -R "$t/$h/.claude/projects/." "$t/all/.claude/projects/"; done
truth() { TZ=Europe/Berlin HOME="$t/all" AGENTGLASS_PRICES="$t/prices.json" AGENTGLASS_OFFLINE=1 "$t/bin/agentglass" cost --json; }
sel='{t: .today.byMode, w: .week.byMode, m: .month.byMode, tu: .today.unpriced.tokens, mu: .month.unpriced.tokens} | tojson'
r6='walk(if type == "number" then (. * 1000000 | round) / 1000000 else . end)'
want=$(truth | jq -c "$r6 | $sel")
printf '{"fleet":{"hosts":[{"name":"h2","ssh":"h2"},{"name":"h3","ssh":"h3"},{"name":"h4","ssh":"h4"}]}}\n' > "$t/h1/.agentglass/config.json"
c=$(run fleet cost --json --refresh)
eq "exact" "$(echo "$c" | jq '.exact')" true
eq "no overlap mark" "$(echo "$c" | jq '.overlap')" 0
eq "copies taken out across hosts (m1, m2, m3 twice, m4, m5, m6)" "$(echo "$c" | jq '.removed')" 7
eq "fleet = one machine reading every log (today, week, month, unpriced)" "$(echo "$c" | jq -c ".total | $r6 | $sel")" "$want"
# the host order in the config decides nothing
printf '{"fleet":{"hosts":[{"name":"h4","ssh":"h4"},{"name":"h2","ssh":"h2"},{"name":"h3","ssh":"h3"}]}}\n' > "$t/h1/.agentglass/config.json"
eq "another host order" "$(run fleet cost --json --refresh | jq -c ".total | $r6 | $sel")" "$want"
# deltas: new messages on two hosts (another copy, a new original), a lost snapshot (the spool state reverts), a restart
msg h2 a1 m8 2400 $S 111 11 0 0 0
msg h3 b1 m8 2500 $S 111 11 0 0 0
msg h4 c1 m9 2600 $Z 222 22 0 0 0
for h in h1 h2 h3 h4; do cp -R "$t/$h/.claude/projects/." "$t/all/.claude/projects/"; done
want2=$(truth | jq -c "$r6 | $sel")
[ "$want2" != "$want" ] || { echo "FAIL the new messages change the truth"; fail=1; }
cp "$t/spool/h3.snap" "$t/h3.snap.before"; cp "$t/spool/h3.j" "$t/h3.j.before" 2> /dev/null || true
eq "after deltas" "$(run fleet cost --json --refresh | jq -c ".total | $r6 | $sel")" "$want2"
grep -q '"base":"[0-9a-f]\{16\}"' "$t/spool/h2.j" || { echo "FAIL the second snapshot of h2 is a delta"; ls -la "$t/spool"; head -c 400 "$t/spool/h2.snap"; echo; cat "$t/spool/h2.rc"; ls -la "$t/h2/.agentglass/fleet-peers" "$t/h2/.agentglass"; fail=1; }
# the viewer loses its last applied delta of h3 (restored from before): it acknowledges the older generation, the host
# answers relative to it, nothing doubles
cp "$t/h3.snap.before" "$t/spool/h3.snap"; rm -f "$t/spool/h3.j"; [ ! -f "$t/h3.j.before" ] || cp "$t/h3.j.before" "$t/spool/h3.j"
eq "after a lost delta" "$(run fleet cost --json --refresh | jq -c ".total | $r6 | $sel")" "$want2"
eq "and once more (no change)" "$(run fleet cost --json --refresh | jq -c ".total | $r6 | $sel")" "$want2"
# a cut delta (no end line): the viewer keeps its state; the host's next answer is relative to the last acknowledged one
msg h3 b2 m10 3000 $S 333 33 0 0 0
for h in h1 h2 h3 h4; do cp -R "$t/$h/.claude/projects/." "$t/all/.claude/projects/"; done
want3=$(truth | jq -c "$r6 | $sel")
printf '{"fleet":{"hosts":[{"name":"h2","ssh":"h2"},{"name":"h3","ssh":"cut-h3"},{"name":"h4","ssh":"h4"}]}}\n' > "$t/h1/.agentglass/config.json"
eq "a cut delta: the state before it" "$(run fleet cost --json --refresh 2> /dev/null | jq -c ".total | $r6 | $sel")" "$want2"
printf '{"fleet":{"hosts":[{"name":"h2","ssh":"h2"},{"name":"h3","ssh":"h3"},{"name":"h4","ssh":"h4"}]}}\n' > "$t/h1/.agentglass/config.json"
eq "after the cut delta" "$(run fleet cost --json --refresh | jq -c ".total | $r6 | $sel")" "$want3"
want2=$want3
# a host's peer state is gone (restored from a backup): a full snapshot, the same totals
rm -rf "$t/h4/.agentglass/fleet-peers"
eq "after the host forgot this viewer" "$(run fleet cost --json --refresh | jq -c ".total | $r6 | $sel")" "$want2"
# reprice off: each host's own table for its usage (the viewer's override no longer applies to remote sonnet usage)
printf '{"fleet":{"reprice":false,"hosts":[{"name":"h2","ssh":"h2"},{"name":"h3","ssh":"h3"},{"name":"h4","ssh":"h4"}]}}\n' > "$t/h1/.agentglass/config.json"
[ "$(run fleet cost --json | jq -c ".total | $r6 | $sel")" != "$want2" ] || { echo "FAIL reprice false keeps the hosts' prices"; fail=1; }
# skills (skill-usage 6.15): the same log with skill loads on h2 and h3 (a tie: h2 owns every message): per skill the
# fleet's $ and loads are one copy's, not two
day=$(jq -nr --argjson s "$d0" '$s | todate | .[0:10]')
for h in h2 h3 all; do p="$t/$h/.claude/projects/-w-sk"; mkdir -p "$p"; sed "s/2026-10-01T/${day}T/g" "$here/testdata/skills/claude.jsonl" > "$p/s-fixture-claude.jsonl"; done
skw=$(TZ=Europe/Berlin HOME="$t/all" AGENTGLASS_PRICES="$t/prices.json" AGENTGLASS_OFFLINE=1 "$t/bin/agentglass" skills --json --period all | jq -c '[.rows[] | {name, l: (.loadsUser + .loadsModel + .loadsCompact), usd: (.usd * 1000000 | round)}] | sort_by(.name)')
sk=$(run fleet skills --json --period all --refresh)
eq "fleet skills: exact" "$(echo "$sk" | jq '.exact')" true
eq "fleet skills: a copied log's skills counted once" "$(echo "$sk" | jq -c '[.rows | group_by(.name)[] | {name: .[0].name, l: (map(.loadsUser + .loadsModel + .loadsCompact) | add), usd: (map(.usd) | add * 1000000 | round)}] | sort_by(.name)')" "$skw"
eq "fleet skills: h2 holds them" "$(echo "$sk" | jq -c '[.rows[] | select(.name == "alpha") | .host]')" '["h2"]'
[ $fail = 0 ] && echo "fleet exact: all checks passed"; exit $fail
