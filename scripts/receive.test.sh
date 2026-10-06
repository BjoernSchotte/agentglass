#!/bin/sh
# agentglass receive against the built binary on 127.0.0.1:0: auth, formats, limits, pinning, rate, rotation, scrub,
# listen policy, lock, disk budget, status, service, signals: sh scripts/receive.test.sh
# check: timing — Expect: 100-continue latency bound; runs alone after the pool
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR
export AGENTGLASS_AGENT=0
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); srv=""; srv2=""
trap '{ [ -z "$srv" ] || kill $srv; [ -z "$srv2" ] || kill $srv2; wait; } 2>/dev/null || true; rm -rf "$t"' EXIT
command -v python3 > /dev/null || { echo "skipped: no python3"; exit 0; }
command -v curl > /dev/null || { echo "skipped: no curl"; exit 0; }
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/ag"; else AGENTGLASS_OUT="$t/ag" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
mkdir -p "$t/home"; hub="$t/hub"
ag() { HOME="$t/home" AGENTGLASS_HUB_DIR="$hub" AGENTGLASS_CONFIG="$t/config.json" AGENTGLASS_NOTIFY=0 "$t/ag" "$@"; }
tokof() { grep -o 'agr_[A-Za-z0-9_-]*' "$1" | head -1; }
start() { # start [dir] : the server on a free port; $srv, $port
  d=${1:-$hub}; rm -f "$d/port"
  HOME="$t/home" AGENTGLASS_HUB_DIR="$d" AGENTGLASS_CONFIG="$t/config.json" AGENTGLASS_NOTIFY=0 "$t/ag" receive --listen 127.0.0.1:0 2> "$t/srv.err" & srv=$!
  i=0; while [ ! -s "$d/port" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done
  port=$(cat "$d/port" 2>/dev/null || echo 0); [ "$port" != 0 ] || { echo "FAIL server did not start: $(cat "$t/srv.err")"; exit 1; }
}
stop() { kill -TERM $srv 2>/dev/null; wait $srv 2>/dev/null; rc=$?; srv=""; }
post() { # post <path> <token|-> <ctype> <file> [extra curl args…]: prints "<code>" ; body in $t/resp, headers in $t/hdr
  p=$1; k=$2; ct=$3; f=$4; shift 4
  if [ "$k" = - ]; then curl -s -o "$t/resp" -D "$t/hdr" -w '%{http_code}' -H "Content-Type: $ct" --data-binary "@$f" "$@" "http://127.0.0.1:$port$p"
  else printf 'header = "Authorization: Bearer %s"\n' "$k" | curl -s -o "$t/resp" -D "$t/hdr" -w '%{http_code}' -K - -H "Content-Type: $ct" --data-binary "@$f" "$@" "http://127.0.0.1:$port$p"; fi
}
today=$(date -u +%Y%m%d)
J="$here/testdata/hub/collector-sample.jsonl"

# tokens: shown once, only hashes at rest; the token never in argv (curl reads it from stdin above)
ag receive token add ci > "$t/ci.out"; tok=$(tokof "$t/ci.out")
eq "token shape" "$(printf %s "$tok" | wc -c | tr -d ' ')" 47
grep -q "Authorization: Bearer $tok" "$t/ci.out" || { echo "FAIL add prints the header line"; fail=1; }
ag receive token add pb > "$t/pb.out"; tpb=$(tokof "$t/pb.out")
ag receive token add rl > "$t/rl.out"; trl=$(tokof "$t/rl.out")
ag receive token add sc > "$t/sc.out"; tsc=$(tokof "$t/sc.out")
set +e; ag receive token add ci > /dev/null 2> "$t/err"; rc=$?; set -e
eq "second add exit" "$rc" 2
grep -q rotate "$t/err" || { echo "FAIL second add hint: $(cat "$t/err")"; fail=1; }
eq "tokens file mode" "$(stat -c %a "$hub/tokens" 2>/dev/null || stat -f %Lp "$hub/tokens")" 600
eq "hub dir mode" "$(stat -c %a "$hub" 2>/dev/null || stat -f %Lp "$hub")" 700
start

# auth before the body
eq "no token" "$(post /v1/traces - application/json "$J")" 401
eq "wrong token" "$(post /v1/traces agr_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA application/json "$J")" 401
eq "not a token" "$(post /v1/traces 'x y' application/json "$J")" 401
grep -qi '^www-authenticate: Bearer' "$t/hdr" || { echo "FAIL 401 without WWW-Authenticate"; fail=1; }
# JSON, gzip JSON; stored per host per UTC day, 0600
eq "json" "$(post /v1/traces "$tok" application/json "$J")" 200
eq "json response" "$(cat "$t/resp")" "{}"
gzip -c "$J" > "$t/s.gz"
eq "gzip json" "$(post /v1/traces "$tok" application/json "$t/s.gz" -H 'Content-Encoding: gzip')" 200
f="$hub/ci/traces-$today.jsonl"
eq "stored lines" "$(wc -l < "$f" | tr -d ' ')" 2
eq "stored mode" "$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")" 600
eq "host dir mode" "$(stat -c %a "$hub/ci" 2>/dev/null || stat -f %Lp "$hub/ci")" 700
grep -q '"hostId":"00112233445566ff"' "$hub/ci/.host" || { echo "FAIL .host: $(cat "$hub/ci/.host")"; fail=1; }
# protobuf and JSON of the same content store identical lines
eq "pb: json first" "$(post /v1/traces "$tpb" application/json "$here/testdata/hub/pb/traces.json")" 200
eq "pb" "$(post /v1/traces "$tpb" application/x-protobuf "$here/testdata/hub/pb/traces.bin")" 200
eq "pb response is empty" "$(wc -c < "$t/resp" | tr -d ' ')" 0
grep -qi '^content-type: application/x-protobuf' "$t/hdr" || { echo "FAIL pb response type"; fail=1; }
eq "pb line = json line" "$(sed -n 1p "$hub/pb/traces-$today.jsonl" | cksum)" "$(sed -n 2p "$hub/pb/traces-$today.jsonl" | cksum)"
eq "pb logs" "$(post /v1/logs "$tpb" application/x-protobuf "$here/testdata/hub/pb/logs.bin")" 200
[ -s "$hub/pb/logs-$today.jsonl" ] || { echo "FAIL logs not stored"; fail=1; }
# metrics accepted and discarded; healthz; paths and methods
eq "metrics" "$(post /v1/metrics "$tok" application/json "$J")" 200
[ ! -e "$hub/ci/metrics-$today.jsonl" ] || { echo "FAIL metrics stored"; fail=1; }
eq "healthz" "$(curl -s "http://127.0.0.1:$port/healthz")" ok
eq "GET traces" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/v1/traces")" 405
eq "unknown path" "$(post /x "$tok" application/json "$J")" 404
eq "bad type" "$(post /v1/traces "$tok" text/plain "$J")" 415
eq "bad encoding" "$(post /v1/traces "$tok" application/json "$J" -H 'Content-Encoding: br')" 415
printf '{"resourceSpans": [' > "$t/broken.json"
eq "broken json" "$(post /v1/traces "$tok" application/json "$t/broken.json")" 400
head -c 300 /dev/urandom > "$t/rand.bin"; printf '\013' > "$t/grp.bin"
eq "garbage protobuf" "$(post /v1/traces "$tok" application/x-protobuf "$t/grp.bin")" 400
code=$(post /v1/traces "$tok" application/x-protobuf "$t/rand.bin"); case $code in 200|400|403) ;; *) echo "FAIL random protobuf: $code"; fail=1 ;; esac
kill -0 $srv 2>/dev/null || { echo "FAIL server died on garbage"; fail=1; }

# limits: body, gzip bombs (a lying ISIZE and an honest one), records
head -c 9437184 /dev/zero > "$t/9mb.json"
eq "9 MB body" "$(post /v1/traces "$tok" application/json "$t/9mb.json")" 413
python3 - "$t" <<'PY'
import gzip, struct, sys, zlib
t = sys.argv[1]
z = zlib.compressobj(9, zlib.DEFLATED, -15)
raw = z.compress(b"\0" * (300 * 1048576)) + z.flush()   # ~300 KB of deflate → 300 MB
hdr = b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\xff"
open(t + "/bomb-isize.gz", "wb").write(hdr + raw + struct.pack("<II", zlib.crc32(b"\0" * 10), 1 << 30))  # ISIZE says 1 GB
open(t + "/bomb-liar.gz", "wb").write(hdr + raw + struct.pack("<II", 0, 10))                            # ISIZE says 10 bytes
spans = ",".join('{"traceId":"%032x","spanId":"%016x","name":"x"}' % (i, i) for i in range(20001))
open(t + "/many.json", "w").write('{"resourceSpans":[{"resource":{"attributes":[]},"scopeSpans":[{"spans":[' + spans + ']}]}]}')
PY
eq "gzip bomb by ISIZE" "$(post /v1/traces "$tok" application/json "$t/bomb-isize.gz" -H 'Content-Encoding: gzip')" 413
eq "gzip bomb with a lying ISIZE" "$(post /v1/traces "$tok" application/json "$t/bomb-liar.gz" -H 'Content-Encoding: gzip')" 413
rss=$(ps -o rss= -p $srv | tr -d ' ')
[ "$rss" -lt 204800 ] || { echo "FAIL RSS after the bombs: ${rss} KB"; fail=1; }
eq "20,001 spans" "$(post /v1/traces "$tok" application/json "$t/many.json")" 413

# pinning: a second host.id under the token → partial success; only foreign ids → 403
python3 - "$t" <<'PY'
import sys
t = sys.argv[1]
def rs(hid, n): return '{"resource":{"attributes":[{"key":"host.id","value":{"stringValue":"%s"}}]},"scopeSpans":[{"spans":[%s]}]}' % (hid, ",".join('{"traceId":"%032x","spanId":"%016x","name":"x"}' % (i, i) for i in range(n)))
open(t + "/mixed.json", "w").write('{"resourceSpans":[%s,%s]}' % (rs("00112233445566ff", 1), rs("ffffffffffffffff", 3)))
open(t + "/foreign.json", "w").write('{"resourceSpans":[%s]}' % rs("ffffffffffffffff", 2))
PY
eq "mixed host ids" "$(post /v1/traces "$tok" application/json "$t/mixed.json")" 200
grep -q '"partialSuccess":{"rejectedSpans":"3","errorMessage":"host.id ffffffffffffffff does not belong to token \\"ci\\"' "$t/resp" || { echo "FAIL partial success: $(cat "$t/resp")"; fail=1; }
grep -q ffffffffffffffff "$hub/ci/traces-$today.jsonl" && { echo "FAIL foreign resource stored"; fail=1; }
eq "foreign host id" "$(post /v1/traces "$tok" application/json "$t/foreign.json")" 403

# scrub: content attributes and user.email never reach the disk
python3 - "$t" <<'PY'
import sys
t = sys.argv[1]
kv = lambda k, v: '{"key":"%s","value":{"stringValue":"%s"}}' % (k, v)
sp = '{"traceId":"%032x","spanId":"%016x","name":"chat","attributes":[%s,%s,%s],"status":{"code":2,"message":"trace with secret code"}}' % (1, 1, kv("gen_ai.input.messages", "SECRET-PROMPT"), kv("gen_ai.tool.call.result", "SECRET-OUTPUT"), kv("agentglass.session.title", "ask me@example.com"))
open(t + "/content.json", "w").write('{"resourceSpans":[{"resource":{"attributes":[%s]},"scopeSpans":[{"spans":[%s]}]}]}' % (kv("user.email", "me@example.com"), sp))
PY
eq "content" "$(post /v1/traces "$tsc" application/json "$t/content.json")" 200
eq "no address on disk" "$(cat "$hub"/*/*.jsonl | grep -c '@example.com' || true)" 0
eq "no content on disk" "$(cat "$hub"/*/*.jsonl | grep -c 'SECRET-\|secret code' || true)" 0
grep -q 'agentglass.session.title' "$hub/sc/traces-$today.jsonl" || { echo "FAIL the scrubbed title is gone"; fail=1; }

# Expect: 100-continue with a 4 MB body: no stall
python3 -c "
import json
print(json.dumps({'resourceSpans':[{'resource':{'attributes':[]},'scopeSpans':[{'spans':[{'traceId':'%032x'%i,'spanId':'%016x'%i,'name':'x'*180} for i in range(19000)]}]}]}))" > "$t/4mb.json"
tt=$(printf 'header = "Authorization: Bearer %s"\n' "$tpb" | curl -s -o /dev/null -w '%{time_total} %{http_code}' -K - -H 'Content-Type: application/json' -H 'Expect: 100-continue' --data-binary "@$t/4mb.json" "http://127.0.0.1:$port/v1/traces")
eq "4 MB with Expect: code" "${tt#* }" 200
awk -v x="${tt% *}" 'BEGIN { exit !(x < 0.2) }' || { echo "FAIL Expect: 100-continue took ${tt% *} s"; fail=1; }

# rate: the 121st request in a minute → 429 with Retry-After
i=0; last=""; while [ $i -lt 121 ]; do last=$(post /v1/metrics "$trl" application/json "$here/testdata/hub/pb/logs.json"); i=$((i+1)); done
eq "121st request" "$last" 429
grep -qi '^retry-after: [0-9]' "$t/hdr" || { echo "FAIL 429 without Retry-After"; fail=1; }

# rotation with grace, revocation within a second
ag receive token rotate ci --grace 1h > "$t/rot.out"; tok2=$(tokof "$t/rot.out")
sleep 1.1
eq "old token in grace" "$(post /v1/traces "$tok" application/json "$J")" 200
eq "new token" "$(post /v1/traces "$tok2" application/json "$J")" 200
ag receive token revoke ci > /dev/null
sleep 1.1
eq "revoked old" "$(post /v1/traces "$tok" application/json "$J")" 401
eq "revoked new" "$(post /v1/traces "$tok2" application/json "$J")" 401
ag receive token list --json > "$t/list.json"
python3 -c "import json,sys; l=json.load(open('$t/list.json')); assert [x['host'] for x in l] == ['pb','rl','sc'], l; assert all('hash' not in x for x in l)" || { echo "FAIL token list: $(cat "$t/list.json")"; fail=1; }

# connection cap (64) and the header timeout (10 s)
python3 - "$port" <<'PY' || fail=1
import socket, sys, time
port = int(sys.argv[1])
idle = [socket.create_connection(("127.0.0.1", port)) for _ in range(64)]
time.sleep(0.3)
s = socket.create_connection(("127.0.0.1", port)); s.settimeout(3)
try: d = s.recv(10)
except Exception as e: d = b"timeout"
if d != b"": print("FAIL 65th connection not closed: %r" % d); sys.exit(1)
t0 = time.time(); idle[0].settimeout(15); idle[0].sendall(b"POST /v1/traces HTTP/1.1\r\nHost: x\r\n")
d = idle[0].recv(10); dt = time.time() - t0
if d != b"" or dt > 12: print("FAIL slow headers kept: %r after %.1f s" % (d, dt)); sys.exit(1)
for x in idle: x.close()
PY
sleep 0.3
eq "serves after the floods" "$(curl -s "http://127.0.0.1:$port/healthz")" ok

# status, the token never on disk, listen policy, the lock
sleep 10.5 # status.json is flushed every 10 s
ag receive status --json > "$t/st.json"
python3 -c "
import json; s=json.load(open('$t/st.json'))
assert s['running'] is True, s
h=s['hosts']['sc']; assert h['requests']==1 and h['scrubbed']>=3, h
assert s['hosts']['ci']['rejected'].get('host-id')==2, s['hosts']['ci']
assert s['hosts']['pb']['hostId']=='0011223344556677', s['hosts']['pb']
assert s['refused'].get('no-token',0)>=1 and s['refused'].get('connections',0)>=1, s['refused']
assert any('scrubbed' in w for w in s['warnings']), s['warnings']" || { echo "FAIL status: $(cat "$t/st.json")"; fail=1; }
ag receive status | grep -q "running (pid $srv)" || { echo "FAIL status text"; fail=1; }
for k in "$tok" "$tok2" "$tpb" "$trl" "$tsc"; do grep -rq -- "${k#agr_}" "$hub" && { echo "FAIL a token is stored in clear"; fail=1; }; done
set +e
ag receive --listen 0.0.0.0:0 > /dev/null 2> "$t/err"; eq "0.0.0.0 exit" "$?" 2
grep -q -- "--listen-public" "$t/err" || { echo "FAIL public bind hint: $(cat "$t/err")"; fail=1; }
ag receive --listen 192.168.1.5:0 --listen-public > /dev/null 2> "$t/err"; eq "public without TLS exit" "$?" 2
ag receive --listen 127.0.0.1:0 > /dev/null 2> "$t/err"; eq "second receive exit" "$?" 3
ag receive --tls-cert /x.pem --tls-key /y.pem --listen 127.0.0.1:0 > /dev/null 2> "$t/err"; eq "tls without the binary exit" "$?" 2
grep -q "agentglass-receive-tls" "$t/err" || { echo "FAIL tls install hint: $(cat "$t/err")"; fail=1; }
set -e
stop; eq "SIGTERM exit" "$rc" 0
[ ! -e "$hub/receive.lock" ] || { echo "FAIL lock left behind"; fail=1; }

# a tokens file others can read: refuse to start
chmod 644 "$hub/tokens"
set +e; ag receive --listen 127.0.0.1:0 > /dev/null 2> "$t/err"; rc=$?; set -e
eq "public tokens file exit" "$rc" 2
grep -q "chmod 600" "$t/err" || { echo "FAIL tokens mode hint: $(cat "$t/err")"; fail=1; }
chmod 600 "$hub/tokens"

# disk budget: today's files over receive.maxDiskMB → 503 Retry-After: 60; older closed days pruned first
printf '{"receive":{"maxDiskMB":1,"retentionDays":30}}\n' > "$t/config.json"
old=$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=3)).strftime('%Y%m%d'))")
ancient=$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=40)).strftime('%Y%m%d'))")
head -c 300000 /dev/zero | tr '\0' 'x' > "$hub/pb/traces-$old.jsonl"; head -c 1000 /dev/zero > "$hub/pb/traces-$ancient.jsonl"
head -c 1200000 /dev/zero | tr '\0' 'y' >> "$hub/sc/traces-$today.jsonl"
start
[ ! -e "$hub/pb/traces-$ancient.jsonl" ] || { echo "FAIL retention kept a 40-day-old file"; fail=1; }
[ ! -e "$hub/pb/traces-$old.jsonl" ] && [ ! -e "$hub/pb/traces-$old.jsonl.gz" ] || { echo "FAIL budget kept an old closed file"; fail=1; }
eq "budget full" "$(post /v1/traces "$tpb" application/json "$here/testdata/hub/pb/traces.json")" 503
grep -qi '^retry-after: 60' "$t/hdr" || { echo "FAIL 503 without Retry-After: 60"; fail=1; }
ag receive status --json | grep -q '"full":true' || { echo "FAIL status does not say full"; fail=1; }
ag receive status | grep -q "disk budget full" || { echo "FAIL status text does not warn"; fail=1; }
stop

ag receive service --print > "$t/unit"
grep -q "ExecStart=$t/ag receive" "$t/unit" || grep -q "<string>$t/ag</string>" "$t/unit" || { echo "FAIL service unit: $(cat "$t/unit")"; fail=1; }
ag receive --help | grep -q "^usage: agentglass receive" || { echo "FAIL receive --help"; fail=1; }
ag receive token --help | grep -q "rotate" || { echo "FAIL token --help"; fail=1; }
[ $fail = 0 ] && echo "receive: ok"
exit $fail
