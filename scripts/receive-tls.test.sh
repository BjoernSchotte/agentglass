#!/bin/sh
# agentglass receive with built-in HTTPS (agentglass-receive-tls, C backend): POST over TLS, token refusal, certificate
# reload on file change, signal forwarding, expiry warning: sh scripts/receive-tls.test.sh
# AGENTGLASS_TLS_BIN: a prebuilt agentglass-receive-tls (release CI), else built here (skipped when the C build fails)
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR
export AGENTGLASS_AGENT=0
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); srv=""
trap '{ [ -z "$srv" ] || kill $srv; wait; } 2>/dev/null || true; rm -rf "$t"' EXIT
# RECEIVE_TLS_REQUIRED=1 (release CI): a skip is a failure
skip() { echo "skipped: $1"; [ -z "${RECEIVE_TLS_REQUIRED:-}" ] || exit 1; exit 0; }
command -v openssl > /dev/null || skip "no openssl"
command -v curl > /dev/null || skip "no curl"
. "$here/scripts/toolchain.sh"
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/agentglass"; else AGENTGLASS_OUT="$t/agentglass" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
if [ -n "${AGENTGLASS_TLS_BIN:-}" ]; then cp "$AGENTGLASS_TLS_BIN" "$t/agentglass-receive-tls"
elif ! scriptc build --backend c ${CHECK_SCRIPTC_FLAGS:-} "$here/src/receive-tls.ts" -o "$t/agentglass-receive-tls" > "$t/tls-build.log" 2>&1; then skip "the C-backend build of src/receive-tls.ts failed here: $(tail -3 "$t/tls-build.log")"; fi
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
mkdir -p "$t/home"; hub="$t/hub"
ag() { HOME="$t/home" AGENTGLASS_HUB_DIR="$hub" AGENTGLASS_NOTIFY=0 "$t/agentglass" "$@"; }
cert() { # cert <name> <days>: a CA-signed server certificate for 127.0.0.1 (the CA from ca.key/ca.crt)
  openssl req -newkey rsa:2048 -nodes -keyout "$t/$1.key" -out "$t/$1.csr" -subj /CN=127.0.0.1 > /dev/null 2>&1
  printf 'subjectAltName=IP:127.0.0.1,IP:127.0.0.2\n' > "$t/ext"
  openssl x509 -req -in "$t/$1.csr" -CA "$t/ca.crt" -CAkey "$t/ca.key" -CAcreateserial -days "$2" -extfile "$t/ext" -out "$t/$1.crt" > /dev/null 2>&1
  chmod 600 "$t/$1.key"
}
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$t/ca.key" -out "$t/ca.crt" -days 2 -subj /CN=agentglass-test-ca > /dev/null 2>&1
cert a 30; cert b 1
cp "$t/a.crt" "$t/srv.crt"; cp "$t/a.key" "$t/srv.key"
ag receive token add ci > "$t/tok.out"; tok=$(grep -o 'agr_[A-Za-z0-9_-]*' "$t/tok.out" | head -1)
HOME="$t/home" AGENTGLASS_HUB_DIR="$hub" AGENTGLASS_NOTIFY=0 "$t/agentglass" receive --tls-cert "$t/srv.crt" --tls-key "$t/srv.key" --listen 127.0.0.1:0 2> "$t/srv.err" & srv=$!
i=0; while [ ! -s "$hub/port" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done
port=$(cat "$hub/port" 2>/dev/null || echo 0); [ "$port" != 0 ] || { echo "FAIL TLS receiver did not start: $(cat "$t/srv.err")"; exit 1; }
post() { printf 'header = "Authorization: Bearer %s"\n' "$1" | curl -s -o "$t/resp" -w '%{http_code}' -K - --cacert "$t/ca.crt" -H 'Content-Type: application/json' --data-binary "@$here/testdata/hub/collector-sample.jsonl" "https://127.0.0.1:$port/v1/traces"; }
serial() { echo | openssl s_client -connect "127.0.0.1:$port" -servername 127.0.0.1 2>/dev/null | openssl x509 -noout -serial; }
eq "TLS POST" "$(post "$tok")" 200
eq "TLS without a token" "$(post agr_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA)" 401
eq "plain HTTP refused" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/healthz" || true)" 000
[ -s "$hub/ci/traces-$(date -u +%Y%m%d).jsonl" ] || { echo "FAIL nothing stored over TLS"; fail=1; }
s1=$(serial); want=$(openssl x509 -noout -serial -in "$t/b.crt")
cp "$t/b.key" "$t/srv.key"; cp "$t/b.crt" "$t/srv.crt"
i=0; while [ "$(serial)" != "$want" ] && [ $i -lt 40 ]; do sleep 0.25; i=$((i+1)); done
eq "certificate reloaded" "$(serial)" "$want"
[ "$s1" != "$want" ] || { echo "FAIL the two certificates share a serial"; fail=1; }
eq "TLS POST after reload" "$(post "$tok")" 200
sleep 10.5 # status.json flush
ag receive status --json > "$t/st.json"
grep -q '"tls":"TLS certificate expires' "$t/st.json" || { echo "FAIL status lacks the certificate expiry: $(cat "$t/st.json")"; fail=1; }
grep -q 'TLS certificate expires .* renew it' "$t/st.json" || { echo "FAIL no expiry warning for a 1-day certificate"; fail=1; }
child=$(cat "$hub/receive.lock" 2>/dev/null | tr -d '\n')
kill -TERM $srv; wait $srv 2>/dev/null || true; srv=""
sleep 0.5
if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then echo "FAIL the TLS child outlived SIGTERM to agentglass receive"; kill "$child"; fail=1; fi
[ ! -e "$hub/receive.lock" ] || { echo "FAIL lock left behind"; fail=1; }
# --listen-public with TLS starts (on loopback: tests never bind a public address, and macOS has no 127.0.0.2)
rm -f "$hub/port"
HOME="$t/home" AGENTGLASS_HUB_DIR="$hub" AGENTGLASS_NOTIFY=0 "$t/agentglass-receive-tls" --tls-cert "$t/a.crt" --tls-key "$t/a.key" --listen 127.0.0.1:0 --listen-public 2> "$t/srv.err" & srv=$!
i=0; while [ ! -s "$hub/port" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done
[ -s "$hub/port" ] || { echo "FAIL --listen-public with TLS did not start: $(cat "$t/srv.err")"; fail=1; }
kill -TERM $srv; wait $srv 2>/dev/null || true; srv=""
[ $fail = 0 ] && echo "receive tls: ok"
exit $fail
