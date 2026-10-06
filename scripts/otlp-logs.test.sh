#!/bin/sh
# --watch --otlp against a local mock: the logs stream (heartbeat, session state, turn.open, an alert from a rule that
# fires) reaches /v1/logs without --jsonl and without JSONL lines on stdout; --jsonl prints the alert line too; a receiver
# answering 404 on /v1/logs switches the stream off while spans continue; --no-logs sends none: sh scripts/otlp-logs.test.sh
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR AGENTGLASS_OTLP_DIR # hermetic: the fake HOME decides
export AGENTGLASS_AGENT=0 # human-mode behavior, also when the suite runs inside a coding agent
command -v python3 > /dev/null || { echo "skipped: no python3"; exit 0; }
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); srv=""; agent=""; trap '{ kill $srv $agent; wait; } 2>/dev/null || true; rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
has() { grep -q -- "$2" "$3" 2>/dev/null || { echo "FAIL $1: no '$2' in $(basename "$3")"; fail=1; }; }
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/ag"; else AGENTGLASS_OUT="$t/ag" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
# mock: appends "<path>" per request to req.log and the (gunzipped) body to <path-name>.jsonl; $t/mode = 404 → /v1/logs 404
cat > "$t/srv.py" <<'PY'
import gzip, http.server, os, sys
d = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        b = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.headers.get("Content-Encoding") == "gzip": b = gzip.decompress(b)
        open(d + "/req.log", "a").write(self.path + "\n")
        open(d + "/" + self.path.strip("/").replace("/", "_") + ".jsonl", "ab").write(b + b"\n")
        st = 404 if self.path == "/v1/logs" and os.path.exists(d + "/mode404") else 200
        self.send_response(st); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"{}")
    def log_message(self, *a): pass
s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(d + "/port", "w").write(str(s.server_port))
s.serve_forever()
PY
python3 "$t/srv.py" "$t" & srv=$!
i=0; while [ ! -s "$t/port" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
url="http://127.0.0.1:$(cat "$t/port")"
# a live Claude session (its registry entry names a running process) with an open turn that has cost; a finished one
p="$t/home/.claude/projects/-w-app"; mkdir -p "$p" "$t/home/.claude/sessions" "$t/home/.agentglass"
echo 00112233445566ff > "$t/home/.agentglass/host-id"
now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
printf '{"type":"user","sessionId":"s1","cwd":"/tmp","timestamp":"%s","message":{"role":"user","content":"build it"}}\n' "$now" > "$p/s1.jsonl"
printf '{"type":"assistant","sessionId":"s1","timestamp":"%s","message":{"id":"m1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"sleep 100"}}],"usage":{"input_tokens":100000,"output_tokens":5000}}}\n' "$now" >> "$p/s1.jsonl"
old=2026-09-01T11:00:00.000Z
printf '{"type":"user","sessionId":"s2","cwd":"/tmp","timestamp":"%s","message":{"role":"user","content":"hi"}}\n' "$old" > "$p/s2.jsonl"
printf '{"type":"assistant","sessionId":"s2","timestamp":"%s","message":{"id":"m2","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":10,"output_tokens":5}}}\n' "$old" >> "$p/s2.jsonl"
touch -t 202609011100 "$p/s2.jsonl"
sleep 120 & agent=$!
printf '{"pid":%s,"sessionId":"s1","status":"busy"}\n' "$agent" > "$t/home/.claude/sessions/$agent.json"
printf '{"version":1,"builtins":false,"rules":[{"id":"spend","metric":"session_cost","op":">","critical":0.01,"ack":"none","notify":false,"message":"spent {value}","labels":{"team":"core"}}]}\n' > "$t/rules.json"
run() { HOME="$t/home" AGENTGLASS_RULES="$t/rules.json" AGENTGLASS_OTLP_DIR="$t/otlp" AGENTGLASS_CACHE_DIR="$t/cache" AGENTGLASS_OFFLINE=1 AGENTGLASS_NOTIFY=0 "$t/ag" --watch --otlp "$url" --for 4s "$@" > "$t/out" 2> "$t/err"; }
reset() { rm -f "$t/req.log" "$t"/v1_*.jsonl "$t/mode404"; rm -rf "$t/otlp"; }

# 1. no --jsonl: the logs stream carries heartbeat, state, turn.open and the rule's alert; stdout stays empty
reset; run
has "logs request" "^/v1/logs$" "$t/req.log"
for n in agentglass.heartbeat agentglass.session.state agentglass.turn.open agentglass.alert; do has "record $n" "\"eventName\":\"$n\"" "$t/v1_logs.jsonl"; done
has "alert label" "agentglass.alert.label.team" "$t/v1_logs.jsonl"
has "host.id" "00112233445566ff" "$t/v1_logs.jsonl"
eq "no JSONL without --jsonl" "$(wc -c < "$t/out" | tr -d ' ')" 0
[ -z "${KEEP:-}" ] || cp "$t/v1_logs.jsonl" "$KEEP"
# 2. --jsonl: the alert line is printed too
reset; run --jsonl
has "jsonl alert line" '"kind":"alert"' "$t/out"
has "logs with --jsonl" "agentglass.alert" "$t/v1_logs.jsonl"
# 3. a receiver without logs: 404 → off with one notice; the finished turn still goes out as spans
reset; touch "$t/mode404"; run --since all
has "404 notice" "takes no OTLP logs" "$t/err"
eq "one logs request" "$(grep -c '^/v1/logs$' "$t/req.log")" 1
has "spans continue" "^/v1/traces$" "$t/req.log"
# 4. --no-logs: none
reset; run --no-logs --since all
eq "--no-logs" "$(grep -c '^/v1/logs$' "$t/req.log" || true)" 0
has "--no-logs spans" "^/v1/traces$" "$t/req.log"
[ $fail = 0 ] && echo "otlp logs: ok"
exit $fail
