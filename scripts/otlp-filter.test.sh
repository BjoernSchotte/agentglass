#!/bin/sh
# --filter on every export path against a local mock receiver: nothing of a session outside the filter reaches any
# request body — not its cwd, title or branch — also when its log has no cwd yet at the start (a negated clause must not
# let it through), when an agent inside the filter moves out of it mid-run, or when its metadata appears late:
# --watch --otlp (spans and the logs stream), export --otlp, and the --watch JSONL lines: sh scripts/otlp-filter.test.sh
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR AGENTGLASS_OTLP_DIR # hermetic: the fake HOME decides
export AGENTGLASS_AGENT=0 # human-mode behavior, also when the suite runs inside a coding agent
command -v python3 > /dev/null || { echo "skipped: no python3"; exit 0; }
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); srv=""; ag=""; a1=""; a2=""; a3=""; a4=""
trap '{ kill $srv $ag $a1 $a2 $a3 $a4; wait; } 2>/dev/null || true; rm -rf "$t"' EXIT
fail=0
has() { grep -q -- "$2" "$3" 2>/dev/null || { echo "FAIL $1: no '$2' in $(basename "$3")"; fail=1; }; }
none() { n=$(cat "$t"/v1_*.jsonl "$t/out" 2>/dev/null | grep -c -- "$2" || true); [ "$n" = 0 ] || { echo "FAIL $1: '$2' appears $n times"; fail=1; }; }
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/ag"; else AGENTGLASS_OUT="$t/ag" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
# mock: the (gunzipped) body of every request to <path-name>.jsonl
cat > "$t/srv.py" <<'PY'
import gzip, http.server, sys
d = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        b = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.headers.get("Content-Encoding") == "gzip": b = gzip.decompress(b)
        open(d + "/" + self.path.strip("/").replace("/", "_") + ".jsonl", "ab").write(b + b"\n")
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"{}")
    def log_message(self, *a): pass
s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(d + "/port", "w").write(str(s.server_port))
s.serve_forever()
PY
python3 "$t/srv.py" "$t" & srv=$!
i=0; while [ ! -s "$t/port" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
url="http://127.0.0.1:$(cat "$t/port")"

H="$t/home"; mkdir -p "$H/.claude/sessions" "$H/.agentglass"
ts() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
# user <id> <cwd> <branch> <prompt> / answer <id> <cwd> <branch> <msg id>: Claude lines in their real shape
user() { printf '{"type":"user","sessionId":"%s","cwd":"%s","gitBranch":"%s","timestamp":"%s","uuid":"u-%s-%s","message":{"role":"user","content":"%s"}}\n' "$1" "$2" "$3" "$(ts)" "$1" "$5" "$4"; }
answer() { printf '{"type":"assistant","sessionId":"%s","cwd":"%s","gitBranch":"%s","timestamp":"%s","message":{"id":"%s","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":100,"output_tokens":5}}}\n' "$1" "$2" "$3" "$(ts)" "$4"; }
live() { printf '{"pid":%s,"sessionId":"%s","status":"busy"}\n' "$2" "$1" > "$H/.claude/sessions/$2.json"; }
setup() {
  rm -rf "$H/.claude/projects" "$H/.claude/sessions"/*.json "$t"/v1_*.jsonl "$t/otlp" "$t/cache" "$t/out"
  # inside: two turns, the first closed
  mkdir -p "$H/.claude/projects/-w-in-app"
  { user sin /w/in-app main "build the app" 1; answer sin /w/in-app main m1; user sin /w/in-app main "add tests" 2; answer sin /w/in-app main m2; } > "$H/.claude/projects/-w-in-app/sin.jsonl"
  # outside from the start
  mkdir -p "$H/.claude/projects/-w-out-secret"
  { user sout /w/out-secret br-out-secret "title-out-secret" 1; answer sout /w/out-secret br-out-secret m1; user sout /w/out-secret br-out-secret "more-out-secret" 2; answer sout /w/out-secret br-out-secret m2; } > "$H/.claude/projects/-w-out-secret/sout.jsonl"
  # inside at the start, moves out during the run (an agent cd-ing elsewhere: its log's cwd follows)
  mkdir -p "$H/.claude/projects/-w-in-mover"
  { user smove /w/in-mover main "move along" 1; answer smove /w/in-mover main m1; } > "$H/.claude/projects/-w-in-mover/smove.jsonl"
  # metadata late: no cwd in the log yet at the start (a snapshot line only), outside once it appears
  mkdir -p "$H/.claude/projects/-w-out-late"
  printf '{"type":"file-history-snapshot","messageId":"x","snapshot":{"trackedFileBackups":{},"timestamp":"%s"}}\n' "$(ts)" > "$H/.claude/projects/-w-out-late/slate.jsonl"
  # a Codex session outside, with a git remote (Codex logs it in its session_meta)
  rm -rf "$H/.codex"; cx="$H/.codex/sessions/$(date +%Y/%m/%d)"; mkdir -p "$cx"
  { printf '{"timestamp":"%s","type":"session_meta","payload":{"id":"44444444-4444-4444-8444-444444444444","timestamp":"%s","cwd":"/w/out-codex","cli_version":"0.120.0","git":{"branch":"br-codex-out","repository_url":"https://example.com/acme/out-remote-secret.git"}}}\n' "$(ts)" "$(ts)"
    printf '{"timestamp":"%s","type":"turn_context","payload":{"cwd":"/w/out-codex","model":"gpt-5.2-codex-mini"}}\n' "$(ts)"
    printf '{"timestamp":"%s","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"codex-out-prompt"}]}}\n' "$(ts)"
    printf '{"timestamp":"%s","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}\n' "$(ts)"
  } > "$cx/rollout-$(date -u +%Y-%m-%dT%H-%M-%S)-44444444-4444-4444-8444-444444444444.jsonl"
  sleep 600 & a1=$!; sleep 600 & a2=$!; sleep 600 & a3=$!; sleep 600 & a4=$!
  live sin $a1; live sout $a2; live smove $a3; live slate $a4
}
grow() { # during a run: the mover leaves, the late session gets its metadata, every session closes a turn
  { user smove /w/out-moved br-out-moved "moved-out-prompt" 2; answer smove /w/out-moved br-out-moved m2; user smove /w/out-moved br-out-moved "again-out-moved" 3; } >> "$H/.claude/projects/-w-in-mover/smove.jsonl"
  { user slate /w/out-late br-out-late "title-out-late" 1; answer slate /w/out-late br-out-late m1; user slate /w/out-late br-out-late "next-out-late" 2; } >> "$H/.claude/projects/-w-out-late/slate.jsonl"
  { user sin /w/in-app main "ship it" 3; } >> "$H/.claude/projects/-w-in-app/sin.jsonl"
  { user sout /w/out-secret br-out-secret "third-out-secret" 3; } >> "$H/.claude/projects/-w-out-secret/sout.jsonl"
  for r in "$H"/.codex/sessions/*/*/*/rollout-*.jsonl; do printf '{"timestamp":"%s","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"codex-out-next"}]}}\n' "$(ts)" >> "$r"; done
}
stop_agents() { kill $a1 $a2 $a3 $a4 2>/dev/null || true; wait $a1 $a2 $a3 $a4 2>/dev/null || true; a1=""; a2=""; a3=""; a4=""; }
env_ag() { HOME="$H" AGENTGLASS_RULES="$t/rules.json" AGENTGLASS_OTLP_DIR="$t/otlp" AGENTGLASS_CACHE_DIR="$t/cache" AGENTGLASS_OFFLINE=1 AGENTGLASS_NOTIFY=0 "$t/ag" "$@"; }
# a rule that fires on every session (an alert record names its session): only the inside ones may reach the receiver
printf '{"version":1,"builtins":false,"rules":[{"id":"any","metric":"session_cost","op":">","critical":0,"ack":"none","notify":false,"message":"spent {value}"}]}\n' > "$t/rules.json"
outside() { # the outside sessions' fields, in every request body and on stdout
  for w in out-secret br-out-secret title-out-secret more-out-secret out-codex br-codex-out out-remote-secret codex-out-prompt codex-out-next out-moved br-out-moved moved-out-prompt out-late br-out-late title-out-late; do none "$1: $w" "$w"; done
  for id in '"sout"' '"slate"' 44444444-4444-4444; do none "$1: session id $id" "$id"; done # their records, whatever the values say
}

# 1. --watch --otlp (spans with --since all, the logs stream, alerts), a positive and a negated filter
# (--redact: the filter means the real values, what goes out are fakes — still none of an outside session's records)
for f in "cwd ~ /w/in-" "not cwd ~ /w/out-" "--redact"; do
  if [ "$f" = --redact ]; then x=--redact; f="cwd ~ /w/in-"; else x=""; fi
  setup
  env_ag --watch --otlp "$url" --since all --for 7s --filter "$f" $x > "$t/out" 2> "$t/err" & ag=$!
  sleep 3; grow; wait $ag || true; ag=""; stop_agents
  has "live [$f$x]: spans of the inside session" '"sin"' "$t/v1_traces.jsonl"
  has "live [$f]: state of the inside session" "agentglass.session.state" "$t/v1_logs.jsonl"
  has "live [$f]: the inside session's state" '"sin"' "$t/v1_logs.jsonl"
  outside "live [$f$x]"
done

# 2. export --otlp (one-shot): a negated clause and a session whose log has no cwd at all
setup; stop_agents
printf '{"type":"file-history-snapshot","messageId":"y","snapshot":{"trackedFileBackups":{},"timestamp":"%s"}}\n' "$(ts)" > "$H/.claude/projects/-w-out-late/slate.jsonl"
for f in "cwd ~ /w/in-" "not cwd ~ /w/out-"; do
  rm -rf "$t"/v1_*.jsonl "$t/otlp"; grow
  env_ag export --otlp "$url" --since all --filter "$f" > "$t/out" 2> "$t/err" || true
  has "export [$f]: the inside session" "/w/in-app" "$t/v1_traces.jsonl"
  outside "export [$f]"
  setup; stop_agents
done

# 3. --watch JSONL (no --otlp): event and alert lines only for the inside sessions, also after the late metadata
for f in "cwd ~ /w/in-" "not cwd ~ /w/out-"; do
  setup
  env_ag --watch --for 6s --filter "$f" > "$t/out" 2> "$t/err" & ag=$!
  sleep 3; grow; wait $ag || true; ag=""; stop_agents
  has "jsonl [$f]: the inside session's event" "ship it" "$t/out"
  outside "jsonl [$f]"
done

# 4. --pinned with --otlp: pins are not applied to an export, so it is refused instead of silently ignored
rc=0; env_ag --watch --otlp "$url" --pinned --for 1s > "$t/out" 2> "$t/err" || rc=$?
[ $rc = 2 ] || { echo "FAIL --pinned with --otlp: exit $rc, want 2"; fail=1; }
has "--pinned with --otlp: the fix" "--filter" "$t/err"
[ $fail = 0 ] && echo "otlp filter: ok"
exit $fail
