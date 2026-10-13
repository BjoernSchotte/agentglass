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
# B ran a 40 s test today (wait.get)
printf '{"type":"assistant","sessionId":"%s","cwd":"/w/srv","timestamp":"%sT00:00:03.000Z","message":{"id":"m-b0","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"pnpm test"}}],"usage":{"input_tokens":10,"output_tokens":1}}}\n' "$B" "$day" >> "$d/$B.jsonl"
printf '{"type":"user","sessionId":"%s","cwd":"/w/srv","timestamp":"%sT00:00:43.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"ok"}]}}\n' "$B" "$day" >> "$d/$B.jsonl"
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
run events "claude:$B" --json > "$t/events.json"; run events "claude:$B" --preset prompts --json > "$t/events-p.json"; run --json --repos > "$t/repos.json"; run --json --repos --days 0 > "$t/repos0.json"; run wait --json > "$t/wait.json"; run wait --by kind --since 1d --json > "$t/wait-k.json"; run cost --json > "$t/cost.json"; run cost --by model --json > "$t/cost-model.json"; run cost --since 7d --filter 'harness is claude' --json > "$t/cost-f.json"; run cost --by session --model claude-sonnet-4-5 --json > "$t/cost-ms.json"; run cost --since 7d --until today --by day --json > "$t/cost-u.json"
rc=0; run serve > /dev/null 2> "$t/err" || rc=$?
[ "$rc" = 2 ] || { echo "FAIL serve without --stdio: exit $rc"; cat "$t/err"; exit 1; }
python3 - "$t" "$d/$A.jsonl" "$A" "$B" << 'PY'
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
cd = req(25, "cost.get", {"since": "7d", "until": time.strftime("%Y-%m-%d"), "by": "day"})
ok("cost.get until as a date (%s)" % (cd and cd.get("err")), cd and "ok" in cd and cd["ok"]["rows"] == json.load(open(t + "/cost-u.json"))["rows"])
cu = req(24, "cost.get", {"since": "7d", "until": "today", "by": "day"})
ok("cost.get since+until = cost --since 7d --until today rows", cu and cu["ok"]["rows"] == json.load(open(t + "/cost-u.json"))["rows"] and len(cu["ok"]["until"]) == 10)
cs = req(23, "cost.get", {"by": "session", "model": "claude-sonnet-4-5"})
ok("cost.get by session + model = cost --by session --model rows (%s | %s)" % (cs and cs["ok"]["rows"], json.load(open(t + "/cost-ms.json"))["rows"]), cs and cs["ok"]["rows"] == json.load(open(t + "/cost-ms.json"))["rows"] and cs["ok"]["model"] == "claude-sonnet-4-5")
ok("cost.get by session: where B is", cs and any(r["key"] == "claude:" + sys.argv[4] and r["project"] and r["cwd"] == "/w/srv" and r["root"] is None and r["costUsd"] > 0 for r in cs["ok"]["rows"]))
for i, (pp, code) in enumerate([({"by": "week"}, "bad_param"), ({"since": "yesterday-ish"}, "bad_param"), ({"filter": "harness is"}, "bad_filter"), ({"harness": "nope"}, "bad_param"), ({"by": 3}, "bad_param"), ({"by": "model", "model": "x"}, "bad_param"), ({"model": 3}, "bad_param"), ({"until": "2026-13-01"}, "bad_param"), ({"since": "today", "until": "2020-01-01"}, "bad_param")]):
    e = req(30 + i, "cost.get", pp)
    ok("cost.get %s → %s (got %s)" % (json.dumps(pp), code, e), e and e.get("err", {}).get("code") == code)
# events.list = events --json (plus truncated, at); filter/preset errors before any read; no content over the protocol
def evOf(x): return {k: v for k, v in x.items() if k not in ("truncated", "at")}
B = sys.argv[4]
ev = req(50, "events.list", {"ref": "claude:" + B})
ok("events.list = events --json", ev and evOf(ev["ok"]) == json.load(open(t + "/events.json")) and ev["ok"]["truncated"] is False)
evp = req(51, "events.list", {"ref": "claude:" + B, "preset": "prompts"})
ok("events.list preset = events --preset --json", evp and evOf(evp["ok"]) == json.load(open(t + "/events-p.json")))
for i, (pp, code) in enumerate([({"ref": "claude:" + B, "filter": "event.kind is"}, "bad_filter"), ({"ref": "claude:" + B, "preset": "nope"}, "bad_param"),
                                ({"ref": "claude:" + B, "preset": "all", "filter": "event.kind is skill"}, "bad_param"), ({"ref": "claude:" + B, "content": True}, "bad_param"),
                                ({"ref": "claude:ffffffff-0000"}, "not_found"), ({}, "bad_param"), ({"ref": "claude:" + B, "limit": 0}, "bad_param")]):
    e = req(52 + i, "events.list", pp)
    ok("events.list %s → %s (got %s)" % (json.dumps(pp), code, e), e and e.get("err", {}).get("code") == code)
# wait.get = wait --json (the now block is of its moment; plus pending, at)
def wOf(x): # the run's own moment: now, the period's end and the previous window's start
    o = {k: v for k, v in x.items() if k not in ("now", "pending", "at", "previous")}; o["period"] = {k: v for k, v in (o.get("period") or {}).items() if k != "until"}; return o
w = req(70, "wait.get", {})
wj = json.load(open(t + "/wait.json"))
ok("wait.get = wait --json", w and wOf(w["ok"]) == wOf(wj) and w["ok"]["pending"] == 0 and isinstance(w["ok"].get("now"), dict))
ok("wait.get: the pnpm test row (kind test, heavy)", w and any(r.get("key") == "pnpm test" and r.get("kind") == "test" and r.get("heavy") is True and r.get("calls") == 1 for r in w["ok"]["rows"]))
wk = req(71, "wait.get", {"by": "kind", "since": "1d"})
ok("wait.get by kind since 1d = wait --by kind --since 1d", wk and wOf(wk["ok"]) == wOf(json.load(open(t + "/wait-k.json"))))
for i, (pp, code) in enumerate([({"by": "nope"}, "bad_param"), ({"since": "soon"}, "bad_param"), ({"filter": "tool is"}, "bad_filter"), ({"limit": 0}, "bad_param"), ({"by": 1}, "bad_param")]):
    e = req(72 + i, "wait.get", pp)
    ok("wait.get %s → %s (got %s)" % (json.dumps(pp), code, e), e and e.get("err", {}).get("code") == code)
# repos.list = --json --repos (rows; plus days, pending, at)
rp = req(80, "repos.list", {})
ok("repos.list = --json --repos", rp and rp["ok"]["rows"] == json.load(open(t + "/repos.json")) and rp["ok"]["days"] == 7 and rp["ok"]["pending"] == 0)
rp0 = req(81, "repos.list", {"days": 0})
ok("repos.list days 0 = --repos --days 0", rp0 and rp0["ok"]["rows"] == json.load(open(t + "/repos0.json")))
for i, (pp, code) in enumerate([({"days": -1}, "bad_param"), ({"days": 1.5}, "bad_param"), ({"filter": "cost >"}, "bad_filter")]):
    e = req(82 + i, "repos.list", pp)
    ok("repos.list %s → %s (got %s)" % (json.dumps(pp), code, e), e and e.get("err", {}).get("code") == code)
# graph.get: B's turn and its Bash call as columns; no content (the command line) anywhere
g = req(90, "graph.get", {"ref": "claude:" + B})
go = g["ok"] if g and "ok" in g else {}
sp = go.get("spans", {}); n = go.get("n", -1)
ok("graph.get: columns of one length", n > 0 and all(len(v) == n for v in sp.values()))
ok("graph.get: a turn and a Bash call", 0 in sp.get("kind", []) and "Bash" in go.get("names", []) and any(go["names"][x] == "Bash" and go["cats"][c] == "shell" for x, c in zip(sp["name"], sp["cat"])))
ok("graph.get: no content", "pnpm test" not in json.dumps(go))
gw = req(91, "graph.get", {"ref": "claude:" + B, "from": go.get("t1", 0) + 60000})
ok("graph.get window after the end: no span", gw and gw["ok"]["n"] == 0 and gw["ok"]["total"] == n)
for i, (pp, code) in enumerate([({}, "bad_param"), ({"ref": "claude:ffffffff-0000"}, "not_found"), ({"ref": "claude:" + B, "from": 10, "to": 5}, "bad_param")]):
    e = req(92 + i, "graph.get", pp)
    ok("graph.get %s → %s (got %s)" % (json.dumps(pp), code, e), e and e.get("err", {}).get("code") == code)
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
# events of the big log: read in slices; meta asked after it answers first
p.stdin.write((json.dumps({"id": 60, "m": "events.list", "p": {"ref": "claude:" + BIG, "preset": "prompts", "limit": 5}}) + "\n" + json.dumps({"id": 61, "m": "meta"}) + "\n").encode()); p.stdin.flush()
order = []; got = {}
def seen2(x):
    if x.get("id") in (60, 61): order.append(x["id"]); got[x["id"]] = x
    return len(order) == 2
read(seen2, 20)
ok("events.list of the big log: meta first (got %s)" % order, order == [61, 60])
e60 = got.get(60, {}).get("ok", {})
evs60 = e60.get("events", [])
ok("events.list of the big log (15 MB): its last 8 MB, unread head first, the last 5 shown", e60.get("truncated") is True and "unread" in (evs60[0] if evs60 else {}) and 0 < e60.get("matched", 0) < 2 * BIG_TURNS and len([x for x in evs60 if "kind" in x]) == 5)
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
# fleet.hosts = fleet status --json over the cached reports, with a dir host configured; serve never removes a spool file
# of a host that is no longer configured (the CLI's fleet status does: it is not serve's to clean)
env3 = dict(env, AGENTGLASS_CONFIG=t + "/fleet-config.json", AGENTGLASS_FLEET_DIR=t + "/fleet3")
os.makedirs(t + "/sync", exist_ok=True); os.makedirs(t + "/fleet3", mode=0o700, exist_ok=True)
open(t + "/fleet-config.json", "w").write(json.dumps({"fleet": {"hosts": [{"name": "nas", "dir": t + "/sync"}]}}))
open(t + "/fleet3/gone.jsonl", "w").write("{}\n")
p = subprocess.Popen([t + "/ag", "serve", "--stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env3); buf = b""
req(1, "hello", {"want": 1})
fl = req(2, "fleet.hosts", {}); me = req(3, "meta", {})
ok("serve kept the spool file of an unconfigured host", os.path.exists(t + "/fleet3/gone.jsonl"))
cli = json.loads(subprocess.run([t + "/ag", "fleet", "status", "--json"], env=env3, capture_output=True).stdout)
def fOf(x): return {k: [{kk: vv for kk, vv in h.items() if kk not in ("okAgeSec", "liveAgeSec")} for h in v] if k == "hosts" else v for k, v in x.items() if k != "at"}
ok("fleet.hosts = fleet status --json (%s)" % json.dumps(fl)[:300], fl and fOf(fl["ok"]) == fOf(cli) and fl["ok"]["hosts"][0]["name"] == "nas")
ok("meta.fleetHosts", me and me["ok"].get("fleetHosts") == 1)
p.stdin.close(); p.wait(timeout=5)
for f in fail: print("FAIL " + f)
sys.exit(1 if fail else 0)
PY
echo "serve: all tests passed"
