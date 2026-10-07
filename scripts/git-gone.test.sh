#!/bin/sh
# agentglass --json git: a session that moved into a worktree since removed keeps its own commits and PRs (its banners and
# links need no reflog): sh scripts/git-gone.test.sh
set -e
export AGENTGLASS_AGENT=0 # human-mode behavior, also when the suite runs inside a coding agent
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
# AGENTGLASS_BIN: a prebuilt binary (scripts/check.sh builds one for every test), else build one here
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/ag"; else AGENTGLASS_OUT="$t/ag" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
M="$t/w/app"; W="$M/.claude/worktrees/feat"
mkdir -p "$M"; echo a > "$M/a.ts"
git -C "$M" init -q -b main
git -C "$M" -c user.email=a@b -c user.name=n add -A
git -C "$M" -c user.email=a@b -c user.name=n commit -qm init
git -C "$M" remote add origin https://github.com/o/app.git
git -C "$M" worktree add -q "$W" -b feat
echo b >> "$W/a.ts"; git -C "$W" -c user.email=a@b -c user.name=n commit -qam 'add the feature' # the banner's commit: in the repo's objects
sha=$(git -C "$W" rev-parse --short=7 HEAD)
H="$t/home"; mkdir -p "$H/.claude/projects/-w-app" "$H/.agentglass"
D=$(date -u +%Y-%m-%dT%H)
C="$H/.claude/projects/-w-app/9a0e0000-0000-4000-8000-000000000001.jsonl"
cl() { printf '%s\n' "$1" >> "$C"; }
# the head is in the main checkout, then the session works (and commits) in the worktree
cl "{\"type\":\"user\",\"timestamp\":\"$D:00:00.000Z\",\"cwd\":\"$M\",\"gitBranch\":\"main\",\"sessionId\":\"9a0e0000-0000-4000-8000-000000000001\",\"message\":{\"role\":\"user\",\"content\":\"add the feature\"}}"
cl "{\"type\":\"assistant\",\"timestamp\":\"$D:00:10.000Z\",\"cwd\":\"$W\",\"gitBranch\":\"feat\",\"message\":{\"id\":\"mg\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_g\",\"name\":\"Bash\",\"input\":{\"command\":\"git commit -am 'add the feature'\"}}],\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}}"
cl "{\"type\":\"user\",\"timestamp\":\"$D:00:13.000Z\",\"cwd\":\"$W\",\"gitBranch\":\"feat\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_g\",\"content\":\"[feat $sha] add the feature\\n 1 file changed, 2 insertions(+)\"}]}}"
cl "{\"type\":\"assistant\",\"timestamp\":\"$D:00:20.000Z\",\"cwd\":\"$W\",\"gitBranch\":\"feat\",\"message\":{\"id\":\"mp\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_p\",\"name\":\"Bash\",\"input\":{\"command\":\"gh pr create --fill\"}}],\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}}"
cl "{\"type\":\"user\",\"timestamp\":\"$D:00:25.000Z\",\"cwd\":\"$W\",\"gitBranch\":\"feat\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_p\",\"content\":\"https://github.com/o/app/pull/7\"}]}}"
git -C "$M" worktree remove --force "$W"
[ ! -d "$W" ] || { echo "FAIL setup: worktree still there"; exit 1; }
run() { HOME="$H" AGENTGLASS_OFFLINE=1 AGENTGLASS_NOTIFY=0 "$t/ag" "$@"; }
j=$(run --json)
g=$(printf '%s' "$j" | grep -o '"git":[^}]*}' | head -1)
case "$g" in *'"sha":"'$sha'"'*'"how":"observed","counted":true'*) ;; *) echo "FAIL removed worktree: own commit: $g"; fail=1 ;; esac
printf '%s' "$j" | grep -q '"prs":\[{"url":"https://github.com/o/app/pull/7","number":7' || { echo "FAIL removed worktree: own PR: $j"; fail=1; }
# a banner whose sha the repo never had (a test script's temp repo): elsewhere, not counted
cl "{\"type\":\"assistant\",\"timestamp\":\"$D:00:30.000Z\",\"cwd\":\"$W\",\"gitBranch\":\"feat\",\"message\":{\"id\":\"mx\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_x\",\"name\":\"Bash\",\"input\":{\"command\":\"cd /tmp/agglp && git cherry-pick f00d123\"}}],\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}}"
cl "{\"type\":\"user\",\"timestamp\":\"$D:00:31.000Z\",\"cwd\":\"$W\",\"gitBranch\":\"feat\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_x\",\"content\":\"[g 9318fc4] fc\\n 1 file changed\"}]}}"
j=$(run --json)
case "$j" in *'"sha":"9318fc4","branch":"g"'*'"counted":false,"status":"elsewhere"'*) ;; *) echo "FAIL foreign banner: $(printf '%s' "$j" | grep -o '"git":[^]]*]')"; fail=1 ;; esac
[ $fail = 0 ] && echo "git gone: all checks passed"
exit $fail
