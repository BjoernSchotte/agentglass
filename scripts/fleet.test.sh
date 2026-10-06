#!/bin/sh
# agentglass fleet end to end with a fake ssh that runs the binary in other fixture homes: sh scripts/fleet.test.sh
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR AGENTGLASS_REDACT AGENTGLASS_FLEET_DIR AGENTGLASS_RUN_DIR AGENTGLASS_SSH AGENTGLASS_FLEET # hermetic
export AGENTGLASS_AGENT=0
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
mkdir -p "$t/bin"
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/bin/agentglass"; else AGENTGLASS_OUT="$t/bin/agentglass" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
# home <name> <session id> <input tokens> <title>: one Claude API-key session; each home its own host id
home() {
  p="$t/$1/.claude/projects/-w-$1"; mkdir -p "$p" "$t/$1/.agentglass"
  printf '{"type":"user","sessionId":"%s","cwd":"/w/%s","timestamp":"%s","message":{"role":"user","content":"%s"}}\n' "$2" "$1" "$now" "$4" > "$p/$2.jsonl"
  printf '{"type":"assistant","sessionId":"%s","timestamp":"%s","message":{"id":"m-%s","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":%s,"output_tokens":0}}}\n' "$2" "$now" "$2" "$3" >> "$p/$2.jsonl"
  printf '{"apiKeyHelper":"/bin/true"}\n' > "$t/$1/.claude/settings.json"
  printf '%s\n' "$5" > "$t/$1/.agentglass/host-id"
}
home h1 v1 1000000 "viewer task" 1111111111111111
home h2 w1 2000000 "secret ws task" 2222222222222222
home h3 x1 1000000 "vm task" 3333333333333333
# the fake ssh: options skipped, the destination picks the home, the remote words run there as a remote shell would
cat > "$t/ssh" <<'SH'
#!/bin/sh
[ "$1" = -V ] && { echo "fake ssh" >&2; exit 0; }
while [ $# -gt 0 ]; do case "$1" in -o|-O) shift 2;; -T) shift;; --) shift; break;; *) break;; esac; done
dest=$1; shift
case "$dest" in
  slow) exec sh -c 'sleep 60; : fleet-test-slow' ;;
  gone) echo "ssh: connect to host gone port 22: Connection refused" >&2; exit 255 ;;
  nodns) echo "ssh: Could not resolve hostname nodns: Name or service not known" >&2; exit 255 ;;
  noauth) echo "me@noauth: Permission denied (publickey)." >&2; exit 255 ;;
  noag) echo "sh: 1: agentglass: not found" >&2; exit 127 ;;
  old) echo "agentglass needs an interactive terminal" >&2; exit 1 ;;
  big) printf '{"hello":{"format":"agentglass-fleet/v1","version":"x","hostId":"9999999999999999","hostName":"big","os":"linux","tzOffsetMin":0,"redact":false,"days":7,"now":1}}\n{"cost":null}\n{"allowance":null}\n'
       pad=$(printf '%2000s' x | tr ' ' p) # real rows run to tens of KB (git, alerts): many 512 KB windows
       i=0; while [ $i -lt 1000 ]; do printf '{"s":{"id":"big%05d","harness":"claude","title":"t","pad":"%s","updated":"2026-10-01T00:00:00.000Z","live":false}}\n' $i "$pad"; i=$((i + 1)); done
       printf '{"end":{"sessions":1000}}\n'; exit 0 ;; # an agentglass without fleet (measured: 2026.10.5)
  cut) HOME="$FAKE_HOMES/h2" eval "$*" | sed '$d'; exit 0 ;;
esac
unset AGENTGLASS_FLEET_DIR AGENTGLASS_RUN_DIR # the viewer's: a host keeps its own peer state (ssh passes no environment)
HOME="$FAKE_HOMES/$dest" eval "$*"
SH
chmod +x "$t/ssh"
export FAKE_HOMES="$t" AGENTGLASS_SSH="$t/ssh" PATH="$t/bin:$PATH"
run() { HOME="$t/h1" AGENTGLASS_OFFLINE=1 AGENTGLASS_NOTIFY=0 AGENTGLASS_FLEET_DIR="$t/spool" AGENTGLASS_RUN_DIR="$t/run" "$t/bin/agentglass" "$@"; }
cfg() { printf '%s\n' "$1" > "$t/h1/.agentglass/config.json"; }
mkdir -p "$t/run"; chmod 700 "$t/run"

# every failure mode at once: two good hosts, one refusing, one hanging past the timeout
cfg '{"fleet":{"hosts":[{"name":"h2","ssh":"h2"},{"name":"h3","ssh":"h3"},{"name":"gone","ssh":"gone"},{"name":"slow","ssh":"slow"}],"timeoutSeconds":10}}'
set +e; j=$(run fleet --json --strict 2> "$t/err"); rc=$?; set -e
eq "strict exit" "$rc" 5
eq "rows: local + h2 + h3" "$(echo "$j" | jq length)" 3
eq "every row has a host" "$(echo "$j" | jq '[.[] | select(.host == null)] | length')" 0
eq "hosts" "$(echo "$j" | jq -r '[.[].host] | sort | join(",")')" "h2,h3,local"
eq "h2 not stale" "$(echo "$j" | jq -r '.[] | select(.host=="h2") | .stale')" false
eq "field order" "$(echo "$j" | jq -r '.[0] | keys_unsorted | .[0:4] | join(",")')" "id,harness,host,title"
grep -q "gone: ssh: connect to host gone port 22: Connection refused" "$t/err" || { echo "FAIL stderr names gone"; cat "$t/err"; fail=1; }
grep -q "slow: timed out after 10 s" "$t/err" || { echo "FAIL stderr names slow"; cat "$t/err"; fail=1; }
s=$(run fleet status --json)
eq "status gone" "$(echo "$s" | jq -r '.hosts[] | select(.name=="gone") | .code')" ssh
eq "status gone message" "$(echo "$s" | jq -r '.hosts[] | select(.name=="gone") | .err | test("Connection refused")')" true
eq "status slow" "$(echo "$s" | jq -r '.hosts[] | select(.name=="slow") | .code')" timeout
eq "status h2" "$(echo "$s" | jq -r '.hosts[] | select(.name=="h2") | .code')" ok
eq "status h2 sessions" "$(echo "$s" | jq -r '.hosts[] | select(.name=="h2") | .sessions')" 1
eq "status h2 host id" "$(echo "$s" | jq -r '.hosts[] | select(.name=="h2") | .hostId')" 2222222222222222
left() { ps -eo args | grep -c '[f]leet-test-slow' || true; }
n=0; while [ "$(left)" != 0 ] && [ $n -lt 30 ]; do sleep 0.1; n=$((n + 1)); done # a TERM'd group may take a moment to go
[ "$(left)" = 0 ] || { echo "FAIL no sleep left from slow:"; ps -eo pid,pgid,ppid,stat,args | grep '[f]leet-test-slow'; fail=1; }
run fleet status | grep -q "✗ ssh: connect to host gone" || { echo "FAIL status text"; run fleet status; fail=1; }
# what fleet status says for each failure: DNS, auth, no agentglass there, an agentglass without fleet
cfg '{"fleet":{"hosts":[{"name":"nodns","ssh":"nodns"},{"name":"noauth","ssh":"noauth"},{"name":"noag","ssh":"noag"},{"name":"old","ssh":"old"}]}}'
run fleet status --refresh > "$t/st"
for want in "✗ ssh: Could not resolve hostname nodns" "✗ me@noauth: Permission denied (publickey). — ssh needs a key without a prompt, or ssh-agent" \
  "✗ agentglass not found on noag: set fleet.hosts[].agentglass" "✗ agentglass on old is older than fleet: update it there"; do
  grep -qF "$want" "$t/st" || { echo "FAIL status: $want"; cat "$t/st"; fail=1; }
done
# a report longer than the TUI's per-tick window (256 lines): the CLI reads it whole, at once and from the cache
cfg '{"fleet":{"hosts":[{"name":"big","ssh":"big"}]}}'
eq "big report: rows" "$(run fleet --json --refresh --filter 'host is big' | jq length)" 1000
eq "big report: status from the cache" "$(run fleet status --json | jq -r '.hosts[0].code + " " + (.hosts[0].sessions | tostring)')" "ok 1000"
# open <ref>@<host>: the ssh command that opens it there; @ this machine's name: a local ref; an unknown host: not found
cfg '{"fleet":{"hosts":[{"name":"h2","ssh":"me@h2","agentglass":"~/.local/bin/agentglass"}]}}'
eq "open @host" "$(run open claude:abcdef12@h2)" "ssh -t me@h2 ~/.local/bin/agentglass open claude:abcdef12"
eq "open @host anchor" "$(run open 'claude:abcdef12@h2#call=c1' --print | jq -r .command)" "ssh -t me@h2 ~/.local/bin/agentglass open claude:abcdef12#call=c1"
set +e; run open claude:abcdef12@local > /dev/null 2> "$t/err"; rc=$?; set -e
eq "open @local: resolved here" "$rc:$(grep -c 'fleet host' "$t/err")" "3:0"
set +e; run open claude:abcdef12@nope > /dev/null 2> "$t/err"; rc=$?; set -e
eq "open @unknown host" "$rc:$(grep -c 'no fleet host nope' "$t/err")" "3:1"

# totals: the sum of each home's own cost --json
cfg '{"fleet":{"hosts":[{"name":"h2","ssh":"h2"},{"name":"h3","ssh":"h3"}]}}'
sum=0; for h in h1 h2 h3; do v=$(HOME="$t/$h" AGENTGLASS_OFFLINE=1 "$t/bin/agentglass" cost --json | jq '.today.byMode.api'); sum=$(echo "$sum + $v" | bc); done
c=$(run fleet cost --json --refresh)
eq "fleet today = sum" "$(echo "$c" | jq '.total.today.byMode.api')" "$sum"
eq "per host" "$(echo "$c" | jq -r '[.hosts[].name] | join(",")')" "local,h2,h3"
eq "no overlap" "$(echo "$c" | jq '.overlap')" 0
run fleet cost | grep -q "^fleet " || { echo "FAIL fleet cost text"; run fleet cost; fail=1; }
eq "filter host is h3" "$(run fleet --json --filter 'host is h3' | jq -r '[.[].id] | join(",")')" x1
eq "table has a host column" "$(run fleet --format table | head -1 | grep -c 'host')" 1
set +e; run fleet --strict > /dev/null 2>&1; rc=$?; set -e
eq "strict ok" "$rc" 0

# the same (harness, id) on two Part A hosts (pulled: no message ids): counted twice, so marked
cp "$t/h3/.claude/projects/-w-h3/x1.jsonl" "$t/h2/.claude/projects/-w-h2/x1.jsonl"
cfg '{"fleet":{"hosts":[{"name":"h2","ssh":"h2","snapshot":false},{"name":"h3","ssh":"h3","snapshot":false}]}}'
c=$(run fleet cost --json --refresh)
eq "overlap" "$(echo "$c" | jq '.overlap')" 1
eq "approx" "$(echo "$c" | jq '.approx')" true
eq "pulled: not exact" "$(echo "$c" | jq '.exact')" false
rm "$t/h2/.claude/projects/-w-h2/x1.jsonl"

# ── Part B: exact merge over snapshots ──
# h3 also holds a copy of h2's history under a new session id (message ids kept): one machine holding every log is the truth
sed 's/"sessionId":"w1"/"sessionId":"w1copy"/' "$t/h2/.claude/projects/-w-h2/w1.jsonl" > "$t/h3/.claude/projects/-w-h3/w1copy.jsonl"
mkdir -p "$t/all/.claude/projects" "$t/all/.agentglass"; cp "$t/h1/.claude/settings.json" "$t/all/.claude/"
for h in h1 h2 h3; do cp -R "$t/$h/.claude/projects/-w-$h" "$t/all/.claude/projects/"; done
truth=$(HOME="$t/all" AGENTGLASS_OFFLINE=1 "$t/bin/agentglass" cost --json | jq '.today.byMode.api')
cat > "$t/ssh-log" <<'SH'
#!/bin/sh
[ "$1" = -V ] && exec "$FAKE_SSH" -V
echo "$*" >> "$FAKE_HOMES/remote-words.log"
exec "$FAKE_SSH" "$@"
SH
chmod +x "$t/ssh-log"; export FAKE_SSH="$t/ssh"
runl() ( AGENTGLASS_SSH="$t/ssh-log"; export AGENTGLASS_SSH; run "$@" ) # a subshell: an assignment before a function call is not portable
rm -rf "$t/spool"; cfg '{"fleet":{"hosts":[{"name":"h2","ssh":"h2"},{"name":"h3","ssh":"h3"}]}}'
c=$(runl fleet cost --json --refresh)
eq "exact" "$(echo "$c" | jq '.exact')" true
eq "exact: no overlap mark" "$(echo "$c" | jq '.overlap')" 0
eq "exact: copies removed once" "$(echo "$c" | jq '.removed')" 1
eq "exact: fleet today = one machine reading every log" "$(echo "$c" | jq '.total.today.byMode.api')" "$truth"
eq "exact: the copy is not double counted (sum of hosts' own is more)" "$(echo "$c" | jq "[.hosts[].cost.today.byMode.api] | add > $truth")" true
eq "exact: status says so" "$(run fleet status --json | jq -r '[.hosts[].exact] | join(",")')" "true,true"
gen=$(grep -h '"snap"' "$t/spool/h2.snap" | head -1 | jq -r .snap.gen)
runl fleet --json --refresh > /dev/null
grep "h2 .*'snapshot'" "$t/remote-words.log" | tail -1 | grep -q "'--ack' '$gen'" || { echo "FAIL the second request acknowledges the first ($gen)"; grep "h2 " "$t/remote-words.log"; fail=1; }
if grep "^.* h2 " "$t/remote-words.log" | grep -q "w1\|m-w1"; then echo "FAIL a session or message id in the remote words"; fail=1; fi
eq "exact: still the truth after a delta" "$(run fleet cost --json | jq '.total.today.byMode.api')" "$truth"
# no message id travels: the snapshot holds only 16-hex hashes
if grep -q '"m-w1"\|m-w1' "$t/spool/h2.snap" "$t/spool/h3.snap"; then echo "FAIL a raw message id in a snapshot"; fail=1; fi
eq "own rows carry 16-hex hashes only" "$(grep -o '"rows":\[\["[^"]*"' "$t/spool/h3.snap" | grep -vc '"rows":\[\["[0-9a-f]\{16\}"$' || true):$(grep -c '"rows":\[\["' "$t/spool/h3.snap")" "0:2"
# a host forced to the pull: inexact again
cfg '{"fleet":{"hosts":[{"name":"h2","ssh":"h2"},{"name":"h3","ssh":"h3","snapshot":false}]}}'
c=$(run fleet cost --json --refresh)
eq "a pulled host: approx" "$(echo "$c" | jq '.approx')" true
# a dir host: h2's drops synced into a folder on the viewer give the same sessions as over ssh
HOME="$t/h2" AGENTGLASS_OFFLINE=1 "$t/bin/agentglass" fleet drop "$t/h2/drop" > /dev/null
mkdir -p "$t/sync"; chmod 700 "$t/sync"; cp "$t/h2/drop/"*.snap.gz "$t/sync/"; chmod 600 "$t/sync/"*
cfg '{"fleet":{"hosts":[{"name":"nas","dir":"'"$t/sync"'"}]}}'
eq "dir host: rows" "$(run fleet --json | jq -r '[.[] | select(.host=="nas") | .id] | sort | join(",")')" "w1"
eq "dir host: exact" "$(run fleet status --json | jq -r '.hosts[0].exact')" true
cfg '{"fleet":{"hosts":[{"name":"h2","ssh":"h2"}]}}'
eq "ssh host: the same rows" "$(run fleet --json --refresh | jq -r '[.[] | select(.host=="h2") | .id] | sort | join(",")')" "w1"
one=$(run fleet cost --json | jq -c '.total')
# one host through two feeds (spec 17): ssh and its drops merge by host id, its rows once, under its first entry
cfg '{"fleet":{"hosts":[{"name":"h2","ssh":"h2"},{"name":"nas","dir":"'"$t/sync"'"}]}}'
eq "two feeds: rows once" "$(run fleet --json --refresh | jq -r '[.[] | select(.host != "local") | .host + ":" + .id] | join(",")')" "h2:w1"
eq "two feeds: counted once" "$(run fleet cost --json | jq -c '.total')" "$one"
s=$(run fleet status --json)
eq "two feeds: the drop is a feed of h2" "$(echo "$s" | jq -r '.hosts[] | select(.name=="nas") | .feedOf + " " + (.dupOf | tostring) + " " + .code')" "h2 null ok"
eq "two feeds: h2 lists them" "$(echo "$s" | jq -r '.hosts[] | select(.name=="h2") | .feeds | join(",")')" "nas"
run fleet status | grep -q "another feed of h2" || { echo "FAIL status text: another feed"; run fleet status; fail=1; }
# fleet watch through the fake ssh: a live session on h2 shows within 3 s, as state only
mkdir -p "$t/h2/.claude/sessions"; sleep 60 & agent=$!
printf '{"pid":%s,"sessionId":"w1","status":"busy"}\n' "$agent" > "$t/h2/.claude/sessions/$agent.json"
"$t/ssh" h2 exec agentglass fleet watch > "$t/watch.out" 2> "$t/watch.err" & wp=$!
n=0; while ! grep -q '"live":{"key":"claude:w1"[^}]*"live":true' "$t/watch.out" 2>/dev/null && [ $n -lt 30 ]; do sleep 0.1; n=$((n + 1)); done
grep -q '"live":{"key":"claude:w1"[^}]*"live":true' "$t/watch.out" || { echo "FAIL fleet watch: no live state within 3 s"; cat "$t/watch.out" "$t/watch.err"; fail=1; }
head -1 "$t/watch.out" | grep -q '^{"hello"' || { echo "FAIL fleet watch: hello first"; fail=1; }
if grep -q 'secret ws task' "$t/watch.out"; then echo "FAIL fleet watch carries content"; fail=1; fi
kill "$wp" "$agent" 2>/dev/null || true; wait "$wp" 2>/dev/null || true; wait "$agent" 2>/dev/null || true; rm -f "$t/h2/.claude/sessions/$agent.json"

# h3 is this machine under another name: not merged
cfg '{"fleet":{"hosts":[{"name":"h2","ssh":"h2"},{"name":"h3","ssh":"h3"}]}}'
cp "$t/h1/.agentglass/host-id" "$t/h3/.agentglass/host-id"
s=$(run fleet status --json --refresh)
eq "duplicate of local" "$(echo "$s" | jq -r '.hosts[] | select(.name=="h3") | .dupOf')" local
eq "its rows are absent" "$(run fleet --json | jq '[.[] | select(.host=="h3")] | length')" 0

# a redacted host: its cache never holds the real title
cfg '{"fleet":{"hosts":[{"name":"h2","ssh":"h2","redact":true}]}}'
run fleet --json --refresh > /dev/null
eq "redacted cache" "$(cat "$t/spool/h2.r."* | grep -c 'secret ws task' || true)" 0
eq "redacted rows" "$(run fleet --json | grep -c 'secret ws task' || true)" 0

# a cut report keeps the previous one
cfg '{"fleet":{"hosts":[{"name":"h2","ssh":"cut"}]}}'
s=$(run fleet status --json --refresh)
eq "cut: status" "$(echo "$s" | jq -r '.hosts[0].code')" cut
eq "cut: previous report kept" "$(echo "$s" | jq -r '.hosts[0].sessions')" 1
eq "cut: rows still there" "$(run fleet --json 2>/dev/null | jq '[.[] | select(.host=="h2")] | length')" 1

# a host removed from the config: its spool files go
cfg '{"fleet":{"hosts":[{"name":"h3","ssh":"h3"}]}}'
run fleet status > /dev/null
eq "forgotten" "$(ls "$t/spool" | grep -c '^h2\.' || true)" 0
# no hosts
cfg '{}'
set +e; run fleet > /dev/null 2> "$t/err"; rc=$?; set -e
eq "no hosts: exit" "$rc" 2
grep -q "no hosts configured" "$t/err" || { echo "FAIL no hosts message"; fail=1; }
[ $fail = 0 ] && echo "fleet: all checks passed"; exit $fail
