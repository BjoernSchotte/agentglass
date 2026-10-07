#!/bin/sh
# OTLP POST against a local mock server: header arrives, gzip body decodes, the token never shows in curl's argv: sh scripts/otlp-transport.test.sh
set -e
export AGENTGLASS_AGENT=0 # human-mode behavior, also when the suite runs inside a coding agent
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); srv=""; snoop=""; trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; { kill $srv $snoop; wait; } 2>/dev/null || true; rm -rf "$t"' EXIT # reaped quietly: no "Terminated"
command -v python3 > /dev/null || { echo "skipped: no python3"; exit 0; }
. "$here/scripts/toolchain.sh"
scriptc build "$here/testdata/otlp/post-driver.ts" -o "$t/post" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
# mock: records headers and the (gunzipped) body, answers slowly so curl's argv can be sampled
cat > "$t/srv.py" <<'PY'
import gzip, http.server, sys, time
d = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        b = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.headers.get("Content-Encoding") == "gzip": b = gzip.decompress(b)
        open(d + "/body", "wb").write(b)
        open(d + "/headers", "w").write("".join(k + ": " + v + "\n" for k, v in self.headers.items()))
        time.sleep(2)
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(b"{}")
    def log_message(self, *a): pass
s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(d + "/port", "w").write(str(s.server_port))
s.serve_forever()
PY
python3 "$t/srv.py" "$t" & srv=$!
i=0; while [ ! -s "$t/port" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
port=$(cat "$t/port")
awk 'BEGIN { printf "{\"resourceSpans\":["; for (i = 0; i < 400; i++) printf "{\"traceId\":\"%032x\",\"name\":\"execute_tool Bash git\"},", i; printf "{}]}" }' > "$t/req.json"
# sample every curl's command line while the request runs (Linux /proc; elsewhere nothing to sample)
if [ -d /proc/self ]; then
  ( while :; do for p in $(pgrep -f -- '-q -sS -K -' 2>/dev/null); do tr '\0' ' ' < "/proc/$p/cmdline" >> "$t/argv" 2>/dev/null && echo >> "$t/argv"; done; sleep 0.05; done ) 2>/dev/null & snoop=$!
fi
OTLP_TEST_TOKEN=t0k3n AGENTGLASS_OTLP_DIR="$t/otlp" "$t/post" "http://127.0.0.1:$port/v1/traces" "$t/req.json" > "$t/out" || { echo "FAIL post: $(cat "$t/out")"; fail=1; }
[ -z "$snoop" ] || { kill $snoop; wait $snoop; } 2>/dev/null || true
eq auth "$(grep -i '^authorization:' "$t/headers" | tr -d '\r')" "Authorization: Bearer t0k3n"
eq encoding "$(grep -i '^content-encoding:' "$t/headers" | tr -d '\r')" "Content-Encoding: gzip"
cmp -s "$t/body" "$t/req.json" || { echo "FAIL body differs"; fail=1; }
if [ -d /proc/self ]; then
  [ -s "$t/argv" ] || { echo "FAIL no curl command line sampled"; fail=1; }
  if grep -q t0k3n "$t/argv" 2>/dev/null; then echo "FAIL token in argv"; fail=1; fi
fi
[ -z "$(ls -A "$t/otlp/tmp" 2>/dev/null)" ] || { echo "FAIL body files left: $(ls "$t/otlp/tmp")"; fail=1; }
[ $fail = 0 ] && echo "otlp transport: ok"
exit $fail
