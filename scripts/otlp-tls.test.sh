#!/bin/sh
# OTLP export over mutual TLS against a local Python server (private CA, server and client certificates made here):
# a full config sends, a missing client certificate or CA fails once with a message that names the fix (no retries),
# a group-readable key or an http:// endpoint is refused before any send, no path shows in curl's argv: sh scripts/otlp-tls.test.sh
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR # hermetic: the fake HOME decides, not the caller's overrides
export AGENTGLASS_AGENT=0 # human-mode behavior, also when the suite runs inside a coding agent
command -v openssl > /dev/null && command -v python3 > /dev/null || { echo "skipped: no openssl/python3"; exit 0; }
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); srv=""; snoop=""; trap '{ kill $srv $snoop; wait; } 2>/dev/null || true; rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
has() { case "$2" in *"$3"*) ;; *) echo "FAIL $1: '$3' not in: $2"; fail=1 ;; esac; }
# AGENTGLASS_BIN: a prebuilt binary (scripts/check.sh builds one for every test), else build one here
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/ag"; else AGENTGLASS_OUT="$t/ag" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
# certificates: a CA, a server certificate for localhost, a client certificate (EC P-256, valid 2 days)
c="$t/tls"; mkdir -p "$c"
( cd "$c"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ca.key -out ca.crt -days 2 -subj /CN=test-ca
  for n in srv cli; do
    openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout $n.key -out $n.csr -subj /CN=$n
    if [ $n = srv ]; then echo "subjectAltName=DNS:localhost,IP:127.0.0.1" > $n.ext; else echo "subjectAltName=DNS:client" > $n.ext; fi
    openssl x509 -req -in $n.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out $n.crt -days 2 -extfile $n.ext
  done
  chmod 600 ./*.key ) > "$t/openssl.log" 2>&1 || { cat "$t/openssl.log"; exit 1; }
# server: TLS with CERT_REQUIRED; logs one "conn" per connection attempt and "POST <path>" per request; slow answers
# so curl's argv can be sampled. Capped at TLS 1.2: Python's server resets the connection after a TLS 1.3 alert and curl
# then sometimes sees a bare reset (send.ts probes for that; send.check covers it) — 1.2 rejects inside the handshake, every time
cat > "$t/srv.py" <<'PY'
import gzip, http.server, ssl, sys, time
d, c = sys.argv[1], sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        b = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.headers.get("Content-Encoding") == "gzip": b = gzip.decompress(b)
        open(d + "/body", "wb").write(b)
        open(d + "/log", "a").write("POST " + self.path + "\n")
        time.sleep(1)
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"{}")
    def log_message(self, *a): pass
class S(http.server.HTTPServer):
    def get_request(self):
        open(d + "/log", "a").write("conn\n")
        return super().get_request()
s = S(("127.0.0.1", 0), H)
x = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); x.load_cert_chain(c + "/srv.crt", c + "/srv.key"); x.load_verify_locations(c + "/ca.crt"); x.verify_mode = ssl.CERT_REQUIRED; x.maximum_version = ssl.TLSVersion.TLSv1_2
s.socket = x.wrap_socket(s.socket, server_side=True)
open(d + "/port", "w").write(str(s.server_port))
s.serve_forever()
PY
python3 "$t/srv.py" "$t" "$c" & srv=$!
i=0; while [ ! -s "$t/port" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
port=$(cat "$t/port"); url="https://localhost:$port"
# one Claude session
p="$t/home/.claude/projects/-w-app"; mkdir -p "$p" "$t/home/.agentglass"
now=2026-09-01T11:00:00.000Z # long quiet: the turn counts as finished
printf '{"type":"user","sessionId":"s1","cwd":"/w/app","timestamp":"%s","message":{"role":"user","content":"hi"}}\n' "$now" > "$p/s1.jsonl"
printf '{"type":"assistant","sessionId":"s1","requestId":"req_1","timestamp":"%s","message":{"id":"m1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":10,"output_tokens":5}}}\n' "$now" >> "$p/s1.jsonl"
touch -t 202609011100 "$p/s1.jsonl"
cfg() { printf '{"otlp":{"tls":{%s}}}\n' "$1" > "$t/home/.agentglass/config.json"; }
run() { HOME="$t/home" AGENTGLASS_OTLP_DIR="$t/otlp" AGENTGLASS_OFFLINE=1 AGENTGLASS_NOTIFY=0 "$t/ag" export --otlp "$1" --since all --resend 2> "$t/err" > "$t/out"; }
ALL="\"ca\":\"$c/ca.crt\",\"cert\":\"$c/cli.crt\",\"key\":\"$c/cli.key\""

# 1. CA + client certificate: sent; curl's argv never holds a path (sampled while the server sleeps)
cfg "$ALL"; : > "$t/log"
if [ -d /proc/self ]; then
  ( while :; do for q in $(pgrep -f -- '-q -sS -K -' 2>/dev/null); do tr '\0' ' ' < "/proc/$q/cmdline" >> "$t/argv" 2>/dev/null && echo >> "$t/argv"; done; sleep 0.05; done ) 2>/dev/null & snoop=$!
fi
rc=0; run "$url" || rc=$?
[ -z "$snoop" ] || { kill $snoop; wait $snoop; } 2>/dev/null || true; snoop=""
eq "mTLS exit" "$rc" 0
eq "mTLS request" "$(grep POST "$t/log")" "POST /v1/traces"
eq "mTLS body" "$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["resourceSpans"]))' "$t/body" 2>/dev/null)" 1
if [ -d /proc/self ]; then
  [ -s "$t/argv" ] || { echo "FAIL no curl command line sampled"; fail=1; }
  if grep -qF "$c/" "$t/argv" 2>/dev/null; then echo "FAIL a TLS path in curl's argv"; fail=1; fi
fi

# 2. no client certificate: the measured exit 56 (TLS 1.3 alert) — one attempt, the message names otlp.tls.cert
cfg "\"ca\":\"$c/ca.crt\""; : > "$t/log"
rc=0; run "$url" || rc=$?
eq "no cert exit" "$rc" 1
has "no cert message" "$(cat "$t/err")" "otlp.tls.cert"
eq "no cert: one attempt" "$(grep -c conn "$t/log")" 1

# 3. no CA: the private CA is not trusted
cfg ""; : > "$t/log"
rc=0; run "$url" || rc=$?
eq "no ca exit" "$rc" 1
has "no ca message" "$(cat "$t/err")" "otlp.tls.ca"
eq "no ca: one attempt" "$(grep -c conn "$t/log")" 1

# 4. a group-readable key: refused before any send
cfg "$ALL"; chmod 644 "$c/cli.key"; : > "$t/log"
rc=0; run "$url" || rc=$?
eq "open key exit" "$rc" 2
has "open key message" "$(cat "$t/err")" "chmod 600"
eq "open key: no connection" "$(grep -c conn "$t/log" || true)" 0
chmod 600 "$c/cli.key"

# 5. TLS settings with an http:// endpoint: refused
rc=0; run "http://localhost:$port" || rc=$?
eq "http exit" "$rc" 2
has "http message" "$(cat "$t/err")" "needs an https endpoint"

# 6. the standard OTel variables instead of the config
cfg ""; : > "$t/log"
rc=0; (OTEL_EXPORTER_OTLP_CERTIFICATE="$c/ca.crt" OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE="$c/cli.crt" OTEL_EXPORTER_OTLP_CLIENT_KEY="$c/cli.key" run "$url") || rc=$? # subshell: macOS sh keeps an assignment before a function call
eq "env exit" "$rc" 0
eq "env request" "$(grep POST "$t/log")" "POST /v1/traces"

[ -z "$(ls -A "$t/otlp/tmp" 2>/dev/null)" ] || { echo "FAIL body files left: $(ls "$t/otlp/tmp")"; fail=1; }
[ $fail = 0 ] && echo "otlp tls: ok"
exit $fail
