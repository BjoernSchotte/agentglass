#!/bin/sh
# agentglass serve --stdio end to end on a fake HOME (local-web-api W2): hello, sessions.list = agentglass --json, sub
# sessions → snapshot, a grown fixture log → a patch for it within 3 s, unsub, stdin closed → exit 0 within 2 s.
# sh scripts/serve.test.sh (AGENTGLASS_BIN: a prebuilt agentglass)
set -e
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; rm -rf "$t"' EXIT
command -v python3 > /dev/null 2>&1 || { echo "serve: skipped (needs python3)"; exit 0; }
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/ag"
else AGENTGLASS_OUT="$t/ag" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
h="$t/h"; d="$h/.claude/projects/-w-srv"; mkdir -p "$d" "$t/run"; chmod 700 "$t/run"
A=cccccc01-0000-4000-8000-000000000001; B=cccccc02-0000-4000-8000-000000000002
day=$(date -u +%Y-%m-%d)
turn() { printf '{"type":"user","sessionId":"%s","cwd":"/w/srv","timestamp":"%sT00:00:0%s.000Z","message":{"role":"user","content":"%s"}}\n' "$1" "$day" "$2" "$3"; }
turn "$A" 1 "first serve topic" > "$d/$A.jsonl"; turn "$B" 1 "second serve topic" > "$d/$B.jsonl"
# the isolation set: nothing of the developer's agentglass state is read or written
cat > "$t/env" << EOF
HOME=$h
PATH=$PATH
AGENTGLASS_AGENT=0
AGENTGLASS_CACHE_DIR=$t/cache
AGENTGLASS_CONFIG=$t/config.json
AGENTGLASS_RULES=/nonexistent
AGENTGLASS_RUN_DIR=$t/run
AGENTGLASS_PALETTE_FILE=$t/palette.json
AGENTGLASS_THEME_FILE=$t/theme
AGENTGLASS_PRICES=$t/prices.json
AGENTGLASS_OTLP_DIR=$t/otlp
AGENTGLASS_FLEET_DIR=$t/fleet
AGENTGLASS_HUB_DIR=$t/hub
AGENTGLASS_TEAM_DIR=$t/team
AGENTGLASS_NOTIFY=0
AGENTGLASS_OFFLINE=1
AGENTGLASS_HERDR=off
AGENTGLASS_REDACT=0
EOF
run() { env -i $(cat "$t/env") "$t/ag" "$@"; }
run --json > "$t/golden.json"
rc=0; run serve > /dev/null 2> "$t/err" || rc=$?
[ "$rc" = 2 ] || { echo "FAIL serve without --stdio: exit $rc"; cat "$t/err"; exit 1; }
python3 - "$t" "$d/$A.jsonl" "$A" << 'PY'
import json, os, select, subprocess, sys, time
t, log, A = sys.argv[1], sys.argv[2], sys.argv[3]
env = dict(l.split("=", 1) for l in open(t + "/env").read().splitlines() if l)
p = subprocess.Popen([t + "/ag", "serve", "--stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
buf = b""
def read(until, secs):
    global buf
    end = time.time() + secs
    while time.time() < end:
        while b"\n" in buf:
            l, buf = buf.split(b"\n", 1)
            m = json.loads(l)
            if until(m): return m
        r, _, _ = select.select([p.stdout], [], [], max(0, end - time.time()))
        if r:
            c = os.read(p.stdout.fileno(), 65536)
            if not c: break
            buf += c
    return None
def req(i, m, params):
    p.stdin.write((json.dumps({"id": i, "m": m, "p": params}) + "\n").encode()); p.stdin.flush()
    return read(lambda x: x.get("id") == i, 10)
fail = []
def ok(what, cond):
    if not cond: fail.append(what)
h = req(1, "hello", {"client": "serve.test", "want": 1})
ok("hello " + json.dumps(h), h and h.get("ok", {}).get("proto") == 1)
golden = json.load(open(t + "/golden.json"))
lst = req(2, "sessions.list", {"limit": 1000})
ok("sessions.list = agentglass --json", lst and lst["ok"]["data"] == golden)
s = req(3, "sub", {"topic": "sessions"})
ok("sub " + json.dumps(s), s and s.get("ok", {}).get("sub") == "s1")
snap = read(lambda x: x.get("sub") == "s1" and x.get("k") == "snapshot", 5)
ok("snapshot", snap and len(snap["d"]["data"]) == 2)
with open(log, "a") as f:
    f.write(json.dumps({"type": "user", "sessionId": A, "cwd": "/w/srv", "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()), "message": {"role": "user", "content": "grown"}}) + "\n")
t0 = time.time()
pt = read(lambda x: x.get("k") == "patch" and any(r.get("id") == A for r in x["d"]["upsert"]), 3) # a warm log: stat'ed every scan
ok("patch for the grown log within 3 s", pt is not None)
if pt: print("serve: patch after %.2f s" % (time.time() - t0))
u = req(4, "unsub", {"sub": "s1"})
ok("unsub", u and u.get("ok") == {})
p.stdin.close(); t1 = time.time()
try: rc = p.wait(timeout=2)
except subprocess.TimeoutExpired: p.kill(); rc = "timeout"
ok("exit 0 within 2 s (got %s)" % rc, rc == 0)
err = p.stderr.read().decode()
ok("stderr quiet: " + err[:200], err.strip() == "")
for f in fail: print("FAIL " + f)
sys.exit(1 if fail else 0)
PY
echo "serve: all tests passed"
