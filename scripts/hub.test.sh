#!/bin/sh
# end to end: agentglass --watch --otlp on fixture home A pushes into agentglass receive (token in a 0600 headers file);
# the hub directory read back like the viewer's hub source: A's sessions, cost, live state, the alert: sh scripts/hub.test.sh
# check: builds 1
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR AGENTGLASS_OTLP_DIR
export AGENTGLASS_AGENT=0
command -v python3 > /dev/null || { echo "skipped: no python3"; exit 0; }
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); srv=""; agent=""
trap '{ [ -z "$srv" ] || kill $srv; [ -z "$agent" ] || kill $agent; wait; } 2>/dev/null || true; rm -rf "$t"' EXIT
. "$here/scripts/toolchain.sh"
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/ag"; else AGENTGLASS_OUT="$t/ag" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
scriptc build ${CHECK_SCRIPTC_FLAGS:-} "$here/testdata/hub/read-driver.ts" -o "$t/read" > "$t/rbuild.log" 2>&1 || { cat "$t/rbuild.log"; exit 1; }
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
hub="$t/hub"; mkdir -p "$t/hubhome"
HOME="$t/hubhome" AGENTGLASS_HUB_DIR="$hub" "$t/ag" receive token add a > "$t/tok"
grep '^  Authorization: Bearer ' "$t/tok" | sed 's/^  //' > "$t/headers"; chmod 600 "$t/headers"
HOME="$t/hubhome" AGENTGLASS_HUB_DIR="$hub" "$t/ag" receive --listen 127.0.0.1:0 2> "$t/srv.err" & srv=$!
i=0; while [ ! -s "$hub/port" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done
port=$(cat "$hub/port")
# host A: a live Claude session with cost, a finished one, a rule that fires
p="$t/a/.claude/projects/-w-app"; mkdir -p "$p" "$t/a/.claude/sessions" "$t/a/.agentglass"
echo 00112233445566ff > "$t/a/.agentglass/host-id"
now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
printf '{"type":"user","sessionId":"s1","cwd":"/tmp","timestamp":"%s","message":{"role":"user","content":"build it"}}\n' "$now" > "$p/s1.jsonl"
printf '{"type":"assistant","sessionId":"s1","timestamp":"%s","message":{"id":"m1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"sleep 100"}}],"usage":{"input_tokens":100000,"output_tokens":5000}}}\n' "$now" >> "$p/s1.jsonl"
old=2026-09-01T11:00:00.000Z
printf '{"type":"user","sessionId":"s2","cwd":"/tmp","timestamp":"%s","message":{"role":"user","content":"hi"}}\n' "$old" > "$p/s2.jsonl"
printf '{"type":"assistant","sessionId":"s2","timestamp":"%s","message":{"id":"m2","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":10,"output_tokens":5}}}\n' "$old" >> "$p/s2.jsonl"
touch -t 202609011100 "$p/s2.jsonl"
sleep 120 & agent=$!
printf '{"pid":%s,"sessionId":"s1","status":"busy"}\n' "$agent" > "$t/a/.claude/sessions/$agent.json"
printf '{"version":1,"builtins":false,"rules":[{"id":"spend","metric":"session_cost","op":">","critical":0.01,"ack":"none","notify":false,"message":"spent {value}"}]}\n' > "$t/rules.json"
printf '{"otlp":{"headersFile":"%s"}}\n' "$t/headers" > "$t/a/.agentglass/config.json"
A() { HOME="$t/a" AGENTGLASS_RULES="$t/rules.json" AGENTGLASS_OTLP_DIR="$t/otlp" AGENTGLASS_CACHE_DIR="$t/cache" AGENTGLASS_OFFLINE=1 AGENTGLASS_NOTIFY=0 "$t/ag" "$@"; }
A --watch --otlp "http://127.0.0.1:$port" --for 4s --since all > "$t/out" 2> "$t/err" || { echo "FAIL exporter: $(cat "$t/err")"; fail=1; }
A --json --filter 'harness is claude' > "$t/a.json"
today=$(date -u +%Y%m%d)
[ -s "$hub/a/traces-$today.jsonl" ] || { echo "FAIL no traces stored: $(cat "$t/err") $(cat "$t/srv.err")"; fail=1; }
[ -s "$hub/a/logs-$today.jsonl" ] || { echo "FAIL no logs stored"; fail=1; }
grep -q '"hostId":"00112233445566ff"' "$hub/a/.host" || { echo "FAIL host not pinned: $(cat "$hub/a/.host")"; fail=1; }
grep -q 'Bearer' "$t/err" "$t/out" && { echo "FAIL the token reached the exporter output"; fail=1; }
"$t/read" "$hub" > "$t/view"
python3 - "$t/view" "$t/a.json" <<'PY' || fail=1
import json, sys
view = [json.loads(l) for l in open(sys.argv[1]) if l.startswith("{")]
src = {s["id"]: s for s in json.load(open(sys.argv[2]))}
ok = True
def bad(m): global ok; print("FAIL " + m); ok = False
if len(view) != 1 or view[0]["name"] != "a" or view[0]["hostId"] != "00112233445566ff": bad("one host a: %r" % view)
h = view[0] if view else {"sessions": [], "live": []}
got = {s["key"].split(":", 1)[1]: s for s in h["sessions"]}
if "s1" not in got: bad("live session s1 missing: %r" % list(got))
for sid in ("s2",): # s1's turn is still open: the export sends a turn's spans when it closes (its cost reaches the hub then)
    if sid not in got: bad("session %s missing: %r" % (sid, list(got))); continue
    g, w = got[sid], src.get(sid)
    if w is None: bad("source lacks " + sid); continue
    if abs((g["costUsd"] or 0) - (w["costUsd"] or 0)) > 1e-9: bad("%s cost %r != source %r" % (sid, g["costUsd"], w["costUsd"]))
    if g["tokens"] != w["tokens"]: bad("%s tokens %r != source %r" % (sid, g["tokens"], w["tokens"]))
    if g["own"] != 1: bad("%s own rows %r" % (sid, g["own"]))
lv = {l["key"]: l for l in h["live"]}
if not lv.get("claude:s1", {}).get("live"): bad("s1 not live from the heartbeat/state: %r" % h["live"])
if lv.get("claude:s1", {}).get("alerts") != 1: bad("the rule's alert is not on s1: %r" % h["live"])
if not h.get("exact"): bad("host not exact")
sys.exit(0 if ok else 1)
PY
kill -TERM $srv; wait $srv 2>/dev/null || true; srv=""
[ $fail = 0 ] && echo "hub end to end: ok"
exit $fail
