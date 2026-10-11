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
# B has priced usage today (cost.get)
printf '{"type":"assistant","sessionId":"%s","cwd":"/w/srv","timestamp":"%sT00:00:02.000Z","message":{"id":"m-b1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":120000,"output_tokens":3000}}}\n' "$B" "$day" >> "$d/$B.jsonl"
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
run cost --json > "$t/cost.json"; run cost --by model --json > "$t/cost-model.json"; run cost --since 7d --filter 'harness is claude' --json > "$t/cost-f.json"
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
# cost.get = cost --json (plus pending, at); with by/since/filter = the cost --by rows
def costOf(x): return {k: v for k, v in x.items() if k not in ("pending", "at", "indexing")}
c = req(20, "cost.get", {})
ok("cost.get = cost --json", c and costOf(c["ok"]) == json.load(open(t + "/cost.json")) and c["ok"]["pending"] == 0)
ok("cost.get: B's usage priced today", c and sum(c["ok"]["today"]["byMode"].values()) > 0)
cm = req(21, "cost.get", {"by": "model"})
ok("cost.get by model = cost --by model rows", cm and cm["ok"]["rows"] == json.load(open(t + "/cost-model.json"))["rows"] and cm["ok"]["by"] == "model")
cf = req(22, "cost.get", {"since": "7d", "filter": "harness is claude"})
ok("cost.get since+filter = cost --since 7d --filter rows (by day)", cf and cf["ok"]["rows"] == json.load(open(t + "/cost-f.json"))["rows"] and cf["ok"]["by"] == "day")
for i, (pp, code) in enumerate([({"by": "week"}, "bad_param"), ({"since": "yesterday-ish"}, "bad_param"), ({"filter": "harness is"}, "bad_filter"), ({"harness": "nope"}, "bad_param"), ({"by": 3}, "bad_param")]):
    e = req(30 + i, "cost.get", pp)
    ok("cost.get %s → %s (got %s)" % (json.dumps(pp), code, e), e and e.get("err", {}).get("code") == code)
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
# sessions.get: full = the CLI's session object; detail fast: index only; a first full ask with logs not read yet (a
# fresh cache below) is read in slices and answered after a later request
full = req(5, "sessions.get", {"ref": "claude:" + A})
ok("sessions.get full: turns and via", full and full["ok"].get("via") == "ref" and isinstance(full["ok"].get("turns"), int))
fast = req(6, "sessions.get", {"ref": "claude:" + A, "detail": "fast"})
ok("sessions.get fast: no transcript figures", fast and fast["ok"].get("detail") == "fast" and fast["ok"].get("turns") is None and fast["ok"].get("models") is not None)
bad = req(7, "sessions.get", {"ref": "claude:" + A, "detail": "slow"})
ok("sessions.get bad detail", bad and bad.get("err", {}).get("code") == "bad_param")
u = req(4, "unsub", {"sub": "s1"})
ok("unsub", u and u.get("ok") == {})
p.stdin.close(); t1 = time.time()
try: rc = p.wait(timeout=2)
except subprocess.TimeoutExpired: p.kill(); rc = "timeout"
ok("exit 0 within 2 s (got %s)" % rc, rc == 0)
err = p.stderr.read().decode()
ok("stderr quiet: " + err[:200], err.strip() == "")
# a fresh cache and a big log (~15 MB): the running summary reads it in slices; meta, asked after it, answers before it;
# the summary is kept in <cache>/detail.jsonl for the next process
import tempfile
BIG = "cccccc09-0000-4000-8000-000000000009"; BIG_TURNS = 3000
with open(os.path.dirname(log) + "/" + BIG + ".jsonl", "w") as f:
    pad = "x" * 2400
    for k in range(BIG_TURNS):
        ts = "2026-10-0%dT%02d:%02d:%02d.000Z" % (1 + k // 1000, (k // 60) % 24, k % 60, k % 60)
        f.write(json.dumps({"type": "user", "sessionId": BIG, "cwd": "/w/srv", "timestamp": ts, "message": {"role": "user", "content": "step %d %s" % (k, pad)}}) + "\n")
        f.write(json.dumps({"type": "assistant", "sessionId": BIG, "cwd": "/w/srv", "timestamp": ts, "message": {"id": "m%d" % k, "role": "assistant", "model": "claude-sonnet-4-5", "content": [{"type": "text", "text": pad}], "usage": {"input_tokens": 10, "output_tokens": 1}}}) + "\n")
env2 = dict(env, AGENTGLASS_CACHE_DIR=tempfile.mkdtemp(dir=t))
p = subprocess.Popen([t + "/ag", "serve", "--stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env2); buf = b""
req(1, "hello", {"want": 1})
t0 = time.time(); c = req(40, "cost.get", {}); dt = time.time() - t0
if c and "ok" in c: print("serve: cold cost.get %.2f s, pending %s, indexing %s" % (dt, c["ok"]["pending"], c["ok"].get("indexing")))
ok("cost.get on a cold start answers at once (%.2f s), the big log pending or counted" % dt, c and "ok" in c and dt < 1.5 and (c["ok"]["pending"] >= 1 or "indexing" not in c["ok"]))
p.stdin.write((json.dumps({"id": 2, "m": "sessions.get", "p": {"ref": "claude:" + BIG}}) + "\n" + json.dumps({"id": 3, "m": "meta"}) + "\n").encode()); p.stdin.flush()
order = []; got = {}
def seen(x):
    if x.get("id") in (2, 3): order.append(x["id"]); got[x["id"]] = x
    return len(order) == 2
read(seen, 15)
ok("first full detail: meta first, then the detail (got %s)" % order, order == [3, 2])
ok("first full detail of the big log: all its turns", 2 in got and got[2].get("ok", {}).get("turns") == BIG_TURNS and got[2]["ok"].get("via") == "ref")
# no subscription: the background index still runs until every log is counted
end = time.time() + 15; c = None; i = 41
while time.time() < end:
    c = req(i, "cost.get", {}); i += 1
    if c and c.get("ok", {}).get("pending") == 0: break
    time.sleep(0.25)
ok("cost.get without a subscription: pending reaches 0 (%s)" % (c and c.get("ok", {}).get("indexing")), c and c["ok"]["pending"] == 0)
# and the index itself finishes (indexing leaves the answer)
end = time.time() + 15
while time.time() < end:
    c = req(i, "cost.get", {}); i += 1
    if c and "indexing" not in c.get("ok", {}): break
    time.sleep(0.25)
ok("the background index finishes without a subscription", c and "indexing" not in c["ok"])
p.stdin.close()
try: p.wait(timeout=5)
except subprocess.TimeoutExpired: p.kill()
ok("the running summary is kept: detail.jsonl", os.path.exists(env2["AGENTGLASS_CACHE_DIR"] + "/detail.jsonl"))
# stdin closed while a subscription runs (agentglass-web gone): exit 0 within 2 s, the cadence must not hold it
p = subprocess.Popen([t + "/ag", "serve", "--stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env); buf = b""
req(1, "hello", {"want": 1}); req(2, "sub", {"topic": "sessions"})
p.stdin.close()
try: rc = p.wait(timeout=2)
except subprocess.TimeoutExpired: rc = None; p.kill()
ok("stdin closed while subscribed: exit 0 within 2 s (got %s)" % rc, rc == 0)
for f in fail: print("FAIL " + f)
sys.exit(1 if fail else 0)
PY
echo "serve: all tests passed"
