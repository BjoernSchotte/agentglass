#!/bin/sh
# a fake herdr CLI for checks: answers from JSON files next to $HERDR_SOCKET_PATH, logs "<socket>|<argv>" to calls.log.
# A file fail-<name> (name = agent-list, workspace-list, tab-list, process-info, status, tab-create, workspace-create,
# agent-start, tab-close, prompt, focus) makes that call print it on stderr and exit 1.
d=$(dirname "${HERDR_SOCKET_PATH:-/nonexistent/x}")
[ -d "$d" ] || { echo '{"error":{"code":"server_not_running","message":"no server"}}' >&2; exit 1; }
printf '%s|%s\n' "$HERDR_SOCKET_PATH" "$*" >> "$d/calls.log"
fail() { if [ -f "$d/fail-$1" ]; then cat "$d/fail-$1" >&2; exit 1; fi; }
ans() { fail "$1"; if [ -f "$d/$1.json" ]; then cat "$d/$1.json"; else echo "{\"result\":{\"type\":\"$1\"}}"; fi; }
case "$1 $2" in
  "agent list") ans agent-list ;;
  "workspace list") ans workspace-list ;;
  "tab list") ans tab-list ;;
  "pane process-info") fail process-info; f="$d/process-info-$4.json"; if [ -f "$f" ]; then cat "$f"; else echo '{"result":{"process_info":{"foreground_processes":[]}}}'; fi ;;
  "status server") fail status; cat "$d/status.txt" 2>/dev/null ;;
  "tab create") ans tab-create ;;
  "workspace create") ans workspace-create ;;
  "agent start") sleep "${FAKE_HERDR_START_SLEEP:-0}"; ans agent-start ;;
  "tab close") ans tab-close ;;
  "agent prompt") sleep 0.3; fail prompt; printf '%s\n' "$4" >> "$d/prompts.log"; echo '{"result":{"type":"agent_prompted"}}' ;;
  "agent focus") fail focus; echo '{"result":{"type":"agent_focused"}}' ;;
  *) echo '{"error":{"code":"unknown","message":"fake herdr: unknown command"}}' >&2; exit 2 ;;
esac
