#!/bin/sh
# agentglass --json --related: Claude, Codex and pi editing src/a.ts in two worktrees of one repo, end to end
set -e
cd "$(dirname "$0")/.."
. ./scripts/toolchain.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
BIN="$T/agentglass"; scriptc build src/main.ts -o "$BIN" >/dev/null
M="$T/w/main"; W2="$T/w/wt2"
mkdir -p "$M/src"; echo a > "$M/src/a.ts"
git -C "$M" init -q -b main
git -C "$M" -c user.email=a@b -c user.name=n add -A
git -C "$M" -c user.email=a@b -c user.name=n commit -qm init
git -C "$M" worktree add -q "$W2" -b wt2
H="$T/home"; mkdir -p "$H/.claude/projects/-w-main" "$H/.codex/sessions/2026/09/30" "$H/.pi/agent/sessions/--w-main--" "$H/.agentglass"
D="2026-09-30T14"
# Claude in main: prompt, Edit src/a.ts at 14:02:31 and 14:06:43, git commit with its banner at 14:10:13
C="$H/.claude/projects/-w-main/c1aude00-0000-4000-8000-000000000001.jsonl"
cl() { printf '%s\n' "$1" >> "$C"; }
cl "{\"type\":\"user\",\"timestamp\":\"$D:00:00.000Z\",\"cwd\":\"$M\",\"sessionId\":\"c1aude00-0000-4000-8000-000000000001\",\"message\":{\"role\":\"user\",\"content\":\"fix the login redirect\"}}"
edit() { # id time
  cl "{\"type\":\"assistant\",\"timestamp\":\"$D:$2.000Z\",\"cwd\":\"$M\",\"message\":{\"id\":\"m$1\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"$1\",\"name\":\"Edit\",\"input\":{\"file_path\":\"$M/src/a.ts\",\"old_string\":\"a\",\"new_string\":\"b\\nc\"}}],\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}}"
  cl "{\"type\":\"user\",\"timestamp\":\"$D:$2.500Z\",\"cwd\":\"$M\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"$1\",\"content\":\"The file has been updated.\"}]}}"
}
edit toolu_e1 02:31; edit toolu_e2 06:43
cl "{\"type\":\"assistant\",\"timestamp\":\"$D:10:10.000Z\",\"cwd\":\"$M\",\"message\":{\"id\":\"mg\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_g\",\"name\":\"Bash\",\"input\":{\"command\":\"git commit -am 'fix login redirect'\"}}],\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}}"
cl "{\"type\":\"user\",\"timestamp\":\"$D:10:13.000Z\",\"cwd\":\"$M\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_g\",\"content\":\"[main 3f2a91c] fix login redirect\\n 1 file changed, 2 insertions(+)\"}]}}"
# Codex in the linked worktree: apply_patch src/a.ts at 14:06:03, npm test failing
X="$H/.codex/sessions/2026/09/30/rollout-2026-09-30T14-05-00-c0dex000-0000-4000-8000-000000000002.jsonl"
cx() { printf '%s\n' "$1" >> "$X"; }
cx "{\"timestamp\":\"$D:05:00.000Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"c0dex000-0000-4000-8000-000000000002\",\"timestamp\":\"$D:05:00.000Z\",\"cwd\":\"$W2\"}}"
cx "{\"timestamp\":\"$D:06:03.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"name\":\"apply_patch\",\"call_id\":\"call_p\",\"input\":\"*** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n-a\\n+b\\n+c\\n*** End Patch\"}}"
cx "{\"timestamp\":\"$D:06:04.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call_output\",\"call_id\":\"call_p\",\"output\":\"Success. Updated the following files:\\nM src/a.ts\"}}"
cx "{\"timestamp\":\"$D:06:10.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"shell\",\"arguments\":\"{\\\"command\\\":[\\\"bash\\\",\\\"-lc\\\",\\\"npm test\\\"]}\",\"call_id\":\"call_t\"}}"
cx "{\"timestamp\":\"$D:06:20.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"call_t\",\"output\":\"Process exited with code 1\"}}"
# pi in main: edit src/a.ts at 14:07:53
P="$H/.pi/agent/sessions/--w-main--/2026-09-30T14-07-00-000Z_p1000000-0000-4000-8000-000000000003.jsonl"
printf '%s\n' "{\"type\":\"session\",\"version\":3,\"id\":\"p1000000-0000-4000-8000-000000000003\",\"timestamp\":\"$D:07:00.000Z\",\"cwd\":\"$M\"}" \
  "{\"type\":\"message\",\"id\":\"e1\",\"parentId\":null,\"timestamp\":\"$D:07:53.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"id\":\"pe1\",\"name\":\"edit\",\"arguments\":{\"path\":\"src/a.ts\",\"edits\":[{\"oldText\":\"b\",\"newText\":\"d\"}]}}],\"model\":\"claude-sonnet-5-5\",\"stopReason\":\"toolUse\"}}" \
  "{\"type\":\"message\",\"id\":\"e2\",\"parentId\":\"e1\",\"timestamp\":\"$D:07:54.000Z\",\"message\":{\"role\":\"toolResult\",\"toolCallId\":\"pe1\",\"toolName\":\"edit\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}],\"isError\":false}}" > "$P"
ag() { env -u CODEX_HOME -u PI_CODING_AGENT_DIR -u PI_CODING_AGENT_SESSION_DIR HOME="$H" AGENTGLASS_AGENT=0 AGENTGLASS_CACHE_DIR="$T/cache" AGENTGLASS_CONFIG="$T/config.json" AGENTGLASS_RULES=/nonexistent AGENTGLASS_NOTIFY=0 "$BIN" "$@"; }
ag --json --related c1aude00 --at "$D:06:43Z" > "$T/out.json" || { echo "FAIL exit $?"; cat "$T/out.json"; exit 1; }
j() { grep -o "$1" "$T/out.json" | head -1; }
fail() { echo "FAIL $1"; cat "$T/out.json"; exit 1; }
[ "$(j '"anchor":{"session":"c1aude00[^"]*","harness":"claude","t":"2026-09-30T14:06:43.000Z","kind":"write","text":"src/a.ts"')" ] || fail "anchor"
# interleaved by time, three harnesses
ORDER=$(grep -o '"t":"2026-09-30T14:[0-9:.]*Z","session":"[a-z0-9]*' "$T/out.json" | sed 's/.*"session":"//' | tr '\n' ' ')
[ "$ORDER" = "c1aude00 c1aude00 c0dex000 c0dex000 c1aude00 p1000000 c1aude00 c1aude00 " ] || fail "order: $ORDER"
# pi: same physical file as Claude → conflict; Codex: same rel path in the other worktree → overlap
[ "$(j '"session":"p1000000[^}]*"kind":"write"[^}]*"conflict":{"kind":"conflict","with":\["c1aude00[^"]*"\]}')" ] || fail "pi conflict"
[ "$(j '"session":"c0dex000[^}]*"kind":"write","tool":"apply_patch"[^}]*"files":\["src/a.ts"\][^}]*"conflict":{"kind":"overlap"')" ] || fail "codex overlap"
[ "$(j '"kind":"shell","tool":"shell","text":"npm test"[^}]*"err":true')" ] || fail "failing npm test"
[ "$(j '"kind":"commit","tool":"","text":"3f2a91c fix login redirect"')" ] || fail "commit row"
[ "$(j '"project":{"key":"gitdir:[^"]*","label":"main"}')" ] || fail "project"
set +e; ag --json --related zzzzzz >/dev/null 2>&1; rc=$?; set -e
[ $rc = 3 ] || { echo "FAIL unknown prefix rc $rc"; exit 1; }
set +e; ag --json --related c1aude00 --minutes 0 >/dev/null 2>&1; rc=$?; set -e
[ $rc = 2 ] || { echo "FAIL --minutes 0 rc $rc"; exit 1; }
echo "related: all e2e checks passed"
