#!/bin/sh
# Alarm latency end to end: fixture agent processes (an idle "pi" and an idle "claude") with their transcripts, the TUI in
# a pseudo-terminal, focused and in the background (focus-out). Four conditions must each reach the bell and the notify
# command within the documented bound — the 1.5 s alarm cadence while an agent runs (README "Light enough to leave open
# all day"; specs/adaptive-refresh) plus 1 s for spawning the command on a loaded host:
#   waiting   pi finishes a turn (built-in turn_done ≥ 0 s)
#   loop      pi calls the same command a third time in a row (built-in repeat_run, critical: stuck; notify on here)
#   tokens    a user rule: session_tokens > 50000
#   approval  claude's tool call stays open with the tree quiet (built-in approval_wait, threshold 2 s here; pi never asks)
# Latency runs from the moment the condition holds (the append; approval: the append + 2 s) to the command's own clock
# and to the bell byte on the terminal.
# sh scripts/alarm-latency.test.sh — prints each latency; ALARM_BOUND_MS overrides the bound (default 2500).
set -e
# check: timing
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR AGENTGLASS_PRICES PI_CODING_AGENT_DIR PI_CODING_AGENT_SESSION_DIR AGENTGLASS_RUN_DIR AGENTGLASS_PALETTE_FILE AGENTGLASS_THEME_FILE AGENTGLASS_OTLP_DIR
command -v python3 > /dev/null || { echo "alarm latency: skipped (needs python3)"; exit 0; }
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); t=$(cd "$t" && pwd -P)
trap 'rm -rf "$t"' EXIT
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/ag"; else AGENTGLASS_OUT="$t/ag" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
H="$t/home"; mkdir -p "$H/.agentglass" "$t/bin" "$t/run"; chmod 700 "$t/run"
# the notify command: rule id and its own clock, one line per run
printf '#!/bin/sh\nprintf "%%s %%s\\n" "$1" "$(python3 -c "import time; print(time.time())")" >> "%s/notes"\n' "$t" > "$t/note.sh"; chmod 755 "$t/note.sh"
cat > "$H/.agentglass/rules.json" <<EOF
{"notify": {"bell": true, "desktop": false, "throttle": "0s", "command": ["$t/note.sh", "{rule}"]},
 "rules": [{"id": "approval", "degraded": "2s", "params": {"samples": 2, "grace": 0}},
           {"id": "loop", "notify": true},
           {"id": "tokens", "metric": "session_tokens", "degraded": 50000, "message": "tokens {value}"}]}
EOF
chmod 600 "$H/.agentglass/rules.json"
# the agents: idle processes named pi and claude in their sessions' cwds. Linux: a symlink to the interpreter keeps the
# name in argv[0] and comm (not to sleep: a multicall coreutils refuses another name). macOS: a copy of sleep (a framework
# Python re-execs Python.app with that path as argv[0], which names no agent)
if [ "$(uname -s)" = Darwin ]; then for n in pi claude; do cp /bin/sleep "$t/bin/$n"; done
else py=$(python3 -c 'import os, sys; print(os.path.realpath(sys.executable))'); ln -s "$py" "$t/bin/pi"; ln -s "$py" "$t/bin/claude"; fi
python3 - "$t" "$H" <<'PY'
import os, pty, sys, time, json, select, subprocess, signal, fcntl, termios, struct
t, H = sys.argv[1:3]
bound = int(os.environ.get("ALARM_BOUND_MS", "2500"))
def iso():
    x = time.time(); return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(x)) + ".%03dZ" % int((x % 1) * 1000)
def enc(p): return "".join(c if c.isalnum() and c.isascii() else "-" for c in p)
fails = 0
for k, mode in enumerate(("focused", "away")):
    W = "%s/w/app%d" % (t, k); C = "%s/w/api%d" % (t, k); os.makedirs(W); os.makedirs(C)
    idle = ["600"] if sys.platform == "darwin" else ["-c", "import time; time.sleep(600)"]
    agents = [subprocess.Popen([t + "/bin/" + n] + idle, cwd=d) for n, d in (("pi", W), ("claude", C))]
    time.sleep(1.2) # a session starts after its process (cwd linking takes the newest session that started after it)
    pid_ = "a1a1a1a1-0000-4000-8000-00000000000%d" % k; cid = "c1c1c1c1-0000-4000-8000-00000000000%d" % k
    pdir = H + "/.pi/agent/sessions/--" + W.strip("/").replace("/", "-") + "--"; os.makedirs(pdir, exist_ok=True)
    plog = pdir + "/" + time.strftime("%Y-%m-%dT%H-%M-%S", time.gmtime()) + "-000Z_" + pid_ + ".jsonl"
    cdir = H + "/.claude/projects/" + enc(C); os.makedirs(cdir, exist_ok=True); clog = cdir + "/" + cid + ".jsonl"
    os.makedirs(H + "/.claude/sessions", exist_ok=True) # claude's registry of running sessions links its pid
    with open(H + "/.claude/sessions/%d.json" % agents[1].pid, "w") as f: json.dump({"pid": agents[1].pid, "sessionId": cid, "status": "busy", "updatedAt": int(time.time() * 1000)}, f)
    seq = [0]
    def add(log, o):
        seq[0] += 1
        with open(log, "a") as f: f.write(json.dumps(o) + "\n")
    def pmsg(role, content, **kw):
        m = {"role": role, "content": content}; m.update(kw)
        add(plog, {"type": "message", "id": "e%d" % (seq[0] + 1), "parentId": None, "timestamp": iso(), "message": m})
    def pcall(cid_, cmd, tok):
        pmsg("assistant", [{"type": "toolCall", "id": cid_, "name": "bash", "arguments": {"command": cmd}}], model="m", provider="p",
             usage={"input": tok, "output": 10, "cacheRead": 0, "cacheWrite": 0, "cost": {"total": 0.001}}, stopReason="toolUse")
    def pres(cid_): pmsg("toolResult", [{"type": "text", "text": "ok"}], toolCallId=cid_, toolName="bash", isError=False)
    def cline(o): o.update({"sessionId": cid, "cwd": C, "timestamp": iso(), "uuid": "u%d" % (seq[0] + 1)}); add(clog, o)
    add(plog, {"type": "session", "version": 3, "id": pid_, "timestamp": iso(), "cwd": W})
    pmsg("user", [{"type": "text", "text": "build a todo app"}])
    cline({"type": "user", "message": {"role": "user", "content": "add an api"}})
    env = {"PATH": os.environ["PATH"], "HOME": H, "TERM": "xterm-256color", "LANG": "C.UTF-8", "AGENTGLASS_AGENT": "0", "AGENTGLASS_OFFLINE": "1",
           "AGENTGLASS_CACHE_DIR": t + "/cache", "AGENTGLASS_CONFIG": t + "/config.json", "AGENTGLASS_RUN_DIR": t + "/run",
           "AGENTGLASS_PALETTE_FILE": t + "/palette.json", "AGENTGLASS_THEME_FILE": t + "/theme", "AGENTGLASS_PRICES": t + "/prices.json",
           "AGENTGLASS_OTLP_DIR": t + "/otlp", "AGENTGLASS_NOTIFY": "0"}
    child, fd = pty.fork()
    if child == 0: os.execve(t + "/ag", [t + "/ag"], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    bells = []
    def pump(sec):
        end = time.time() + sec
        while True:
            left = end - time.time()
            if left <= 0: return
            r, _, _ = select.select([fd], [], [], min(left, 0.05))
            if r:
                try: d = os.read(fd, 65536)
                except OSError: return
                if b"\x07" in d: bells.append(time.time())
    def notes():
        try: return [l.split() for l in open(t + "/notes").read().splitlines()]
        except FileNotFoundError: return []
    def wait(rule, t0, seen, sec=15):
        end = time.time() + sec
        while time.time() < end:
            pump(0.03)
            hits = [x for x in notes() if x[0] == rule]
            if len(hits) > seen:
                pump(0.2) # the bell of that frame
                return float(hits[-1][1]) - t0, min([b for b in bells if b >= t0 - 0.05], default=t0 - 1) - t0
        return -1, -1
    def cond(rule, act, delay=0.0):
        seen = len([x for x in notes() if x[0] == rule]); t0 = time.time(); act()
        return (rule, wait(rule, t0 + delay, seen))
    pump(6) # first frame; the process scan links both agents to their sessions; CPU samples gather
    os.write(fd, b"\x1b[O" if mode == "away" else b"\x1b[I")
    pump(3) # the level settles
    res = []
    res.append(cond("waiting", lambda: pmsg("assistant", [{"type": "text", "text": "done"}], model="m", provider="p",
                    usage={"input": 100, "output": 10, "cacheRead": 0, "cacheWrite": 0, "cost": {"total": 0.001}}, stopReason="stop")))
    pmsg("user", [{"type": "text", "text": "and the tests"}]); pump(2)
    pcall("l1", "npm test", 100); pres("l1"); pcall("l2", "npm test", 100); pres("l2"); pump(2)
    res.append(cond("loop", lambda: (pcall("l3", "npm test", 100), pres("l3"))))
    pmsg("user", [{"type": "text", "text": "go on"}]); pump(2)
    res.append(cond("tokens", lambda: pcall("x1", "ls", 60000)))
    res.append(cond("approval", lambda: cline({"type": "assistant", "message": {"id": "m%d" % k, "role": "assistant", "model": "claude-sonnet-4-5",
                    "content": [{"type": "tool_use", "id": "tu%d" % k, "name": "Bash", "input": {"command": "npm test"}}], "stop_reason": "tool_use",
                    "usage": {"input_tokens": 10, "output_tokens": 5}}}), 2.0))
    for name, (cmd, bell) in res:
        ok = 0 <= cmd * 1000 <= bound and 0 <= bell * 1000 <= bound
        print("%-7s %-8s notify %5d ms  bell %5d ms%s" % (mode, name, cmd * 1000, bell * 1000, "" if ok else "  FAIL (bound %d ms)" % bound))
        if not ok: fails += 1
    if fails: # what the TUI could see: the agents' command lines (an agent must be named by argv[0])
        print(subprocess.run(["ps", "-o", "pid=,args=", "-p", ",".join(str(a.pid) for a in agents)], capture_output=True, text=True).stdout.rstrip())
    os.kill(child, signal.SIGTERM); pump(1)
    try: os.waitpid(child, 0)
    except ChildProcessError: pass
    os.close(fd)
    for a in agents: a.terminate(); a.wait()
print("alarm latency: all within %d ms" % bound if not fails else "alarm latency: %d over the bound of %d ms" % (fails, bound))
sys.exit(1 if fails else 0)
PY
