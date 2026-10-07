#!/bin/sh
# agentglass open end to end on a fake HOME: a running TUI takes the link (spool hand-off), exit codes, --new-instance,
# --print, an unsafe run dir, a hung server, quit cleanup: sh scripts/open.test.sh
set -e
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d)
srv=0; cleanup() { [ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; [ "$srv" -gt 0 ] && kill -CONT "$srv" 2>/dev/null; [ "$srv" -gt 0 ] && kill -TERM "$srv" 2>/dev/null; rm -rf "$t"; }
trap cleanup EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
has() { case "$2" in *"$3"*) ;; *) echo "FAIL $1: '$3' not in: $2"; fail=1 ;; esac; }
command -v python3 > /dev/null 2>&1 || { echo "open: skipped (needs python3 for a PTY)"; exit 0; }
# AGENTGLASS_BIN: a prebuilt binary (scripts/check.sh builds one for every test), else build one here
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/ag"; else AGENTGLASS_OUT="$t/ag" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
h="$t/h"; p1="$h/w/p1"; mkdir -p "$p1/.git"
A=abcdef01-0000-4000-8000-000000000001; B=abcdef02-0000-4000-8000-000000000002
cp="$h/.claude/projects/-w-p1"; mkdir -p "$cp"
for id in $A $B; do
  { printf '{"type":"user","sessionId":"%s","cwd":"%s","timestamp":"2026-10-01T10:00:00.000Z","message":{"role":"user","content":"hello %s"}}\n' "$id" "$p1" "$id"
    printf '{"type":"assistant","sessionId":"%s","cwd":"%s","timestamp":"2026-10-01T10:00:01.000Z","message":{"id":"m1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"tool_use","id":"toolu_%s","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":1,"output_tokens":1}}}\n' "$id" "$p1" "${id%%-*}"; } > "$cp/$id.jsonl"
done
run() { env -i HOME="$h" PATH="$PATH" TERM=xterm-256color AGENTGLASS_CACHE_DIR="$t/cache" AGENTGLASS_CONFIG="$t/config.json" AGENTGLASS_RULES=/nonexistent AGENTGLASS_NOTIFY=0 AGENTGLASS_OFFLINE=1 "$@"; }
# a PTY around "$@" (stdin and stdout are terminals: the TUI path); prints the output, exits with the child's code
cat > "$t/pty.py" << 'PY'
import os, sys, signal, time
pid, fd = os.forkpty()
if pid == 0: os.execvp(sys.argv[2], sys.argv[2:])
limit = float(sys.argv[1]); t0 = time.time(); out = b""; code = None
while True:
    if time.time() - t0 > limit: os.kill(pid, signal.SIGTERM); code = 124
    try:
        import select
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            b = os.read(fd, 65536)
            if not b: break
            out += b
    except OSError: break
    w, st = os.waitpid(pid, os.WNOHANG)
    if w:
        if code is None: code = os.waitstatus_to_exitcode(st)
        break
if code is None: code = os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1])
sys.stdout.buffer.write(out); sys.exit(code if code >= 0 else 128 - code)
PY
pty() { lim=$1; shift; run python3 "$t/pty.py" "$lim" "$@"; }
run_dir="$h/.agentglass/run"; inbox="$run_dir/inbox"
# the server: a TUI under a PTY for up to 120 s
pty 120 "$t/ag" > /dev/null 2>&1 &
i=0; while [ ! -f "$run_dir/tui.lock" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
srv=$(cat "$run_dir/tui.lock" 2>/dev/null | tr -d '\n'); [ -n "$srv" ] || { echo "FAIL no server lock"; exit 1; }
eq "run dir 0700" "$(stat -c %a "$run_dir" 2>/dev/null || stat -f %Lp "$run_dir")" 700
eq "lock 0600" "$(stat -c %a "$run_dir/tui.lock" 2>/dev/null || stat -f %Lp "$run_dir/tui.lock")" 600
# ready: the lock is taken before the first frame, while the TUI's start may still hold its loop (a loaded CI runner took
# over 2 s there); a link the server answers (an unknown session: exit 3 either way) says it polls its inbox now. The
# product's 2 s stays: the timed checks below run against a server that is up
# (a start held for 3 s here, as a loaded runner holds it: the readiness wait must ride it out)
kill -STOP "$srv"; ( sleep 3; kill -CONT "$srv" ) &
i=0; while [ $i -lt 15 ]; do o=$(pty 10 "$t/ag" open zzzzzzzz-1 2>&1) || true; case "$o" in *"asked the running agentglass"*) break ;; esac; i=$((i + 1)); done
[ $i -lt 15 ] || { echo "FAIL the server never answered a link: $o"; exit 1; }
n0=$(pgrep -c -f "$t/ag" || true)
# a link while the server runs: handed off, exit 0, no second TUI, inbox empty
s0=$(date +%s)
o=$(pty 10 "$t/ag" open "$A#call=toolu_abcdef01" 2>&1) && c=0 || c=$?
eq "hand-off exit" "$c" 0; has "hand-off message" "$o" "opened in running agentglass (pid $srv)"
[ $(( $(date +%s) - s0 )) -le 3 ] || { echo "FAIL hand-off took more than 2 s"; fail=1; }
eq "no second TUI" "$(pgrep -c -f "$t/ag" || true)" "$n0"; eq "inbox empty" "$(ls -A "$inbox")" ""
# unknown session (valid grammar): the server answers not-found → 3; a bad ref → 2 before any hand-off
o=$(pty 10 "$t/ag" open zzzzzzzz-1 2>&1) && c=0 || c=$?
eq "not found exit" "$c" 3; has "not found message" "$o" "asked the running agentglass"
m0=$(ls -la --time-style=full-iso "$inbox" 2>/dev/null || ls -laT "$inbox")
o=$(pty 10 "$t/ag" open ../x 2>&1) && c=0 || c=$?
eq "bad ref exit" "$c" 2; eq "inbox untouched by a bad ref" "$(ls -la --time-style=full-iso "$inbox" 2>/dev/null || ls -laT "$inbox")" "$m0"
# --new-instance: its own TUI (killed by the 2 s limit → 124), the inbox never written
o=$(pty 2 "$t/ag" open "$B" --new-instance 2>&1) && c=0 || c=$?
eq "new instance runs its own TUI" "$c" 124; eq "inbox untouched by --new-instance" "$(ls -la --time-style=full-iso "$inbox" 2>/dev/null || ls -laT "$inbox")" "$m0"
# --print (no PTY): JSON, no hand-off
o=$(run "$t/ag" open "$B" --print) && c=0 || c=$?
eq "print exit" "$c" 0; has "print json" "$o" "\"url\":\"agentglass://open/claude/$B\""
# an unsafe run dir: the client warns and opens its own TUI
chmod 0750 "$run_dir"
o=$(pty 2 "$t/ag" open "$B" 2>&1) && c=0 || c=$?
eq "unsafe run dir: own TUI" "$c" 124; has "unsafe run dir warning" "$o" "allows group/other access"
chmod 0700 "$run_dir"
# a hung server: the client falls back after 2 s
kill -STOP "$srv"; s0=$(date +%s)
o=$(pty 5 "$t/ag" open "$B" 2>&1) && c=0 || c=$?
kill -CONT "$srv"
eq "hung server: own TUI" "$c" 124; has "hung server warning" "$o" "did not answer within 2 s"
eq "hung server: our link withdrawn" "$(ls -A "$inbox")" ""
# quit (SIGTERM): the lock is released
kill -TERM "$srv"; i=0; while [ -f "$run_dir/tui.lock" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
[ -f "$run_dir/tui.lock" ] && { echo "FAIL lock left after SIGTERM"; fail=1; }
srv=0
# twins: the same session under a second project dir (a copied ~/.claude) is one session: a full id, claude:<id> and a
# prefix open the copy at home (the dir Claude names after its cwd), never "ambiguous", though the other copy is newer;
# compare takes it too
enc=$(printf %s "$p1" | sed 's/[^a-zA-Z0-9]/-/g'); tw="$h/.claude/projects/$enc"; mkdir -p "$tw"
cp "$cp/$A.jsonl" "$tw/$A.jsonl"; touch -t 202601010000 "$tw/$A.jsonl"; touch "$cp/$A.jsonl"
for ref in "$A" "claude:$A" "${A%%-*}"; do
  o=$(run "$t/ag" open "$ref" --print 2>&1) && c=0 || c=$?
  eq "twins: open $ref exit" "$c" 0
  has "twins: open $ref picks the home copy" "$o" "projects/$enc/$A.jsonl"
done
o=$(run "$t/ag" compare "claude:$A" "claude:$B" --json 2>&1) && c=0 || c=$?
eq "twins: compare exit" "$c" 0
# different sessions under one prefix stay ambiguous; the hint names refs that resolve
o=$(run "$t/ag" open abcdef --print 2>&1) && c=0 || c=$?
eq "different sessions: ambiguous" "$c" 4
has "different sessions: the hint names full refs" "$o" "use one of: claude:"
[ $fail = 0 ] && echo "open: all e2e tests passed"
exit $fail
