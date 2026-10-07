#!/bin/sh
# herdr end to end against an isolated herdr server (own config dir and socket, never the user's): --json mux and
# workspace cost, send from the TUI, the blocked refusal and ◆, jump, resume in a new tab, the plugin popup quitting.
# Skipped where herdr or python3 is missing (CI): sh scripts/mux-herdr.test.sh
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
HB=$(command -v herdr 2>/dev/null || true)
[ -n "$HB" ] || { echo "mux-herdr: skipped (no herdr)"; exit 0; }
command -v python3 > /dev/null 2>&1 || { echo "mux-herdr: skipped (needs python3 for a PTY)"; exit 0; }
[ -x /usr/bin/dash ] && [ -x /bin/bash ] || { echo "mux-herdr: skipped (needs dash and bash for the stand-in agents)"; exit 0; }
t=$(mktemp -d) # short: the socket path must stay under ~100 bytes
srv=0
cleanup() {
  [ "$(exec sh -c "echo \$PPID")" = $$ ] || exit
  if [ "$srv" -gt 0 ]; then
    for p in $(cat "$t/agent.pids" 2>/dev/null); do kill -TERM "$p" 2>/dev/null || true; done
    H server stop > /dev/null 2>&1 || true; sleep 0.5; kill -TERM "$srv" 2>/dev/null || true
  fi
  rm -rf "$t"
}
trap cleanup EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
has() { case "$2" in *"$3"*) ;; *) echo "FAIL $1: '$3' not in: $(printf %s "$2" | tail -c 300)"; fail=1 ;; esac; }
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/ag"; else AGENTGLASS_OUT="$t/ag" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
sock="$t/cfg/herdr/herdr.sock"; mkdir -p "$t/cfg/herdr" "$t/state" "$t/home" "$t/bin" "$t/w" "$t/p"
# the isolated server and its CLI: nothing of the caller's herdr environment reaches it
H() { env -i HOME="$t/home" XDG_CONFIG_HOME="$t/cfg" XDG_STATE_HOME="$t/state" HERDR_SOCKET_PATH="$sock" PATH="$t/bin:/usr/bin:/bin" TERM=xterm-256color "$HB" "$@"; }
J() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
# stand-in agents. claude (argv0 "claude": herdr and agentglass both see a Claude) types what it reads into recv.txt;
# $t/bin/claude is what `herdr agent start --kind claude` runs (resume): it records its argv; pi.js runs as
# "node pi.js" (agentglass: pi; herdr does not detect it, so states reported for it stick)
printf '#!/bin/bash\nexec -a claude /usr/bin/dash -c '"'"'while IFS= read -r l; do printf "%%s\\n" "$l" >> %s/recv.txt; done'"'"'\n' "$t" > "$t/bin/standin"
printf '#!/bin/bash\nprintf "%%s\\n" "$@" > %s/argv.txt\nexec -a claude /usr/bin/dash -c '"'"'while IFS= read -r l; do :; done'"'"'\n' "$t" > "$t/bin/claude"
printf 'while IFS= read -r l; do :; done\n' > "$t/pi.js"
chmod 755 "$t/bin/standin" "$t/bin/claude"
(cd "$t/w" && git init -q . 2>/dev/null) || true
env -i HOME="$t/home" XDG_CONFIG_HOME="$t/cfg" XDG_STATE_HOME="$t/state" HERDR_SOCKET_PATH="$sock" PATH="$t/bin:/usr/bin:/bin" TERM=xterm-256color setsid "$HB" server > "$t/server.log" 2>&1 &
srv=$!
i=0; while [ ! -S "$sock" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
[ -S "$sock" ] || { echo "FAIL isolated herdr server did not start"; cat "$t/server.log"; exit 1; }
A=abcdef01-0000-4000-8000-0000000000a1; B=abcdef02-0000-4000-8000-0000000000b2; PI=abcdef03-0000-4000-8000-0000000000c3
P1=$(H workspace create --cwd "$t/w" --label fixture --no-focus | J "d['result']['root_pane']['pane_id']")
P2=$(H workspace create --cwd "$t/p" --label pis --no-focus | J "d['result']['root_pane']['pane_id']")
sleep 1
H pane run "$P1" "$t/bin/standin" > /dev/null
H pane run "$P2" "bash -c 'exec -a node /usr/bin/dash $t/pi.js'" > /dev/null
sleep 1.5
H pane report-agent-session "$P1" --source herdr:claude --agent claude --agent-session-id "$A" > /dev/null
H pane report-agent "$P2" --source plugin:agentglass-test --agent pi --state working > /dev/null
for p in "$P1" "$P2"; do H pane process-info --pane "$p" | J "' '.join(str(x['pid']) for x in d['result']['process_info']['foreground_processes'])"; done > "$t/agent.pids"
# a fake HOME: Claude sessions A (live, through herdr's agent_session) and B (ended) in $t/w, no registry; a pi session in $t/p
h="$t/home"; cp="$h/.claude/projects/-w"; mkdir -p "$cp" "$h/.pi/agent/sessions/--p--"
now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
for id in $A $B; do
  { printf '{"type":"user","sessionId":"%s","cwd":"%s","timestamp":"%s","message":{"role":"user","content":"hello %s"}}\n' "$id" "$t/w" "$now" "$id"
    printf '{"type":"assistant","sessionId":"%s","cwd":"%s","timestamp":"%s","message":{"id":"m1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":100,"output_tokens":10}}}\n' "$id" "$t/w" "$now"; } > "$cp/$id.jsonl"
done
touch -t "$(date +%Y%m%d)0000" "$cp/$B.jsonl"
{ printf '{"type":"session","version":3,"id":"%s","timestamp":"%s","cwd":"%s"}\n' "$PI" "$now" "$t/p"
  printf '{"type":"message","timestamp":"%s","message":{"role":"user","content":"build it"}}\n' "$now"; } > "$h/.pi/agent/sessions/--p--/$(date -u +%Y-%m-%dT%H-%M-%S)-000Z_$PI.jsonl"
run() { env -i HOME="$h" PATH="/usr/bin:/bin" TERM=xterm-256color AGENTGLASS_CACHE_DIR="$t/cache" AGENTGLASS_CONFIG="$t/config.json" AGENTGLASS_RULES=/nonexistent \
  AGENTGLASS_NOTIFY=0 AGENTGLASS_OFFLINE=1 AGENTGLASS_AGENT=0 AGENTGLASS_RUN_DIR="$t/run" AGENTGLASS_HERDR="$HB" AGENTGLASS_HERDR_SOCKET="$sock" "$@"; }

# --json: A is live through herdr's agent_session, in pane P1 of workspace "fixture"
out=$(run "$t/ag" --json --live --all-projects --fields id,pid,mux_kind,mux_pane,mux_workspace --format csv)
has "--json A live in herdr" "$out" "$A,"
has "--json mux" "$out" ",herdr,$P1,fixture"
has "--json pi live in herdr" "$out" "$PI,"
eq "cost by workspace" "$(run "$t/ag" cost --since today --by workspace --format csv --fields key,workspaceId | grep -c "^fixture,w")" 1
eq "filter mux is herdr" "$(run "$t/ag" --json --all-projects --filter 'mux is herdr' --fields id --format csv | tail -n +2 | sort | tr '\n' ' ')" "$(printf '%s\n%s\n' "$A" "$PI" | sort | tr '\n' ' ')"

# the TUI in a PTY, driven by steps: keys, waits and expectations on the screen text (since the last mark)
cat > "$t/drive.py" << 'PY'
import os, sys, json, time, select, re, signal
steps = json.loads(sys.argv[1]); argv = sys.argv[2:]
pid, fd = os.forkpty()
if pid == 0: os.execvp(argv[0], argv)
import fcntl, termios, struct
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
buf = b""; mark = 0; bad = 0; exited = None
ESC = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>]")
def pump(sec):
    global buf, exited
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try: b = os.read(fd, 65536)
            except OSError: b = b""
            if b: buf += b
        if exited is None:
            w, st = os.waitpid(pid, os.WNOHANG)
            if w: exited = st
def text(): return ESC.sub(b"", buf[mark:]).decode("utf-8", "replace")
pump(2.5)
for s in steps:
    k = s[0]
    if k == "keys":
        for ch in s[1]: os.write(fd, ch.encode()); pump(0.15)
    elif k == "sleep": pump(float(s[1]))
    elif k == "mark": mark = len(buf)
    elif k == "expect":
        end = time.time() + float(s[2])
        while time.time() < end and s[1] not in text(): pump(0.2)
        if s[1] in text(): print("ok   " + s[1])
        else: bad += 1; print("FAIL expect " + repr(s[1]) + " — screen tail: " + repr(text()[-400:]))
    elif k == "exits":
        end = time.time() + float(s[1])
        while time.time() < end and exited is None: pump(0.2)
        if exited is None: bad += 1; print("FAIL the TUI did not quit")
        else: print("ok   quit")
if exited is None:
    os.write(fd, b"q"); pump(1.0)
    if exited is None:
        try: os.kill(pid, signal.SIGTERM)
        except OSError: pass
        pump(0.5)
sys.exit(1 if bad else 0)
PY
# send: typed into the stand-in's pane; then blocked: refused with the toast, the pi row shows ◆
H pane report-agent "$P2" --source plugin:agentglass-test --agent pi --state blocked > /dev/null
steps=$(python3 -c 'import json,sys; print(json.dumps([
  ["mark"], ["keys", "s"], ["sleep", 0.3], ["keys", "hello herdr\r"], ["expect", "sent to herdr", 4],
  ["keys", "\x1b"], ["sleep", 0.5], ["mark"], ["expect", "◆", 12]]))')
set +e; run python3 "$t/drive.py" "$steps" "$t/ag" open "claude:$A" --new-instance > "$t/tui1.log" 2>&1; rc=$?; set -e
cat "$t/tui1.log" | grep -E '^(ok|FAIL)' || true; [ $rc = 0 ] || fail=1
eq "send delivered" "$(cat "$t/recv.txt" 2>/dev/null)" "hello herdr"
# a send to the blocked pane: refused by herdr, nothing typed (herdr's own agent_blocked)
set +e; H agent prompt "$P2" "nope" > /dev/null 2> "$t/blocked.err"; rc=$?; set -e
eq "blocked refused" "$rc|$(grep -c agent_blocked "$t/blocked.err")" "1|1"

# jump: focus elsewhere, R on the live A focuses its pane
H agent focus "$P2" > /dev/null 2>&1 || H pane focus "$P2" > /dev/null 2>&1 || true
steps=$(python3 -c 'import json; print(json.dumps([["mark"], ["keys", "R"], ["expect", "focused in herdr", 4]]))')
set +e; run python3 "$t/drive.py" "$steps" "$t/ag" open "claude:$A" --new-instance > "$t/tui2.log" 2>&1; rc=$?; set -e
grep -E '^(ok|FAIL)' "$t/tui2.log" || true; [ $rc = 0 ] || fail=1
eq "jump focused P1" "$(H agent list | J "[a['focused'] for a in d['result']['agents'] if a['pane_id']=='$P1'][0]")" True

# the plugin popup (HERDR_PLUGIN_ID): a successful jump quits it
steps=$(python3 -c 'import json; print(json.dumps([["keys", "R"], ["exits", 4]]))')
set +e; run env HERDR_PLUGIN_ID=agentglass python3 "$t/drive.py" "$steps" "$t/ag" open "claude:$A" --new-instance > "$t/tui3.log" 2>&1; rc=$?; set -e
grep -E '^(ok|FAIL)' "$t/tui3.log" || true; [ $rc = 0 ] || fail=1

# resume inside herdr: R on the ended B opens a new tab in workspace fixture and starts claude --resume B there
W1=$(H workspace list | J "[w['workspace_id'] for w in d['result']['workspaces'] if w['label']=='fixture'][0]")
ntabs() { H tab list | J "len([t for t in d['result']['tabs'] if t['workspace_id']=='$1'])"; }
tabs0=$(ntabs "$W1"); all0=$(H tab list | J "len(d['result']['tabs'])")
steps=$(python3 -c 'import json; print(json.dumps([["mark"], ["keys", "R"], ["expect", "resumed in herdr", 35]]))')
set +e; run env HERDR_ENV=1 HERDR_SOCKET_PATH="$sock" python3 "$t/drive.py" "$steps" "$t/ag" open "claude:$B" --new-instance > "$t/tui4.log" 2>&1; rc=$?; set -e
grep -E '^(ok|FAIL)' "$t/tui4.log" || true; [ $rc = 0 ] || fail=1
i=0; while ! grep -q -- "--resume" "$t/argv.txt" 2>/dev/null && [ $i -lt 70 ]; do sleep 0.5; i=$((i + 1)); done
eq "resume argv" "$(tr '\n' ' ' < "$t/argv.txt" 2>/dev/null)" "--resume $B "
eq "resume: one new tab, in workspace fixture (its agent works in the session's directory)" "$(ntabs "$W1")|$(H tab list | J "len(d['result']['tabs'])")" "$((tabs0 + 1))|$((all0 + 1))"
for p in $(H agent list | J "' '.join(a['pane_id'] for a in d['result']['agents'])"); do H pane process-info --pane "$p" 2>/dev/null | J "' '.join(str(x['pid']) for x in d['result']['process_info']['foreground_processes'])" >> "$t/agent.pids" 2>/dev/null || true; done

[ $fail = 0 ] && echo "mux-herdr: all checks passed"
exit $fail
