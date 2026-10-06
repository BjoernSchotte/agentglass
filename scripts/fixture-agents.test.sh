#!/bin/sh
# fixture agents (scripts/fixture-agents.sh): fake claude/codex/gemini processes with children, a held-open Codex rollout,
# streamed transcripts and a Claude registry, on Linux and macOS; no agentglass: sh scripts/fixture-agents.test.sh
set -e
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d)
fail=0; no() { echo "FAIL $*"; fail=1; }
trap 'sh "$here/scripts/fixture-agents.sh" stop "$t" > /dev/null 2>&1 || true; rm -rf "$t"' EXIT
out=$(sh "$here/scripts/fixture-agents.sh" start "$t" --agents 3 --history 5 --background 2)
[ "$out" = "agents 3 pids 5" ] || no "start printed '$out'"
h="$t/home"
set -- $(cat "$t/agents"); cl=$1; cx=$2; gm=$3
args() { ps -o args= -p "$1" 2> /dev/null; }
case "$(args "$cl")" in */claude\ *) ;; *) no "claude args: $(args "$cl")";; esac
case "$(args "$cx")" in */codex\ *) ;; *) no "codex args: $(args "$cx")";; esac
case "$(args "$gm")" in */node\ */gemini.js\ *) ;; *) no "gemini args: $(args "$gm")";; esac
grep -q '"sessionId":"' "$h/.claude/sessions/$cl.json" 2> /dev/null && grep -q "\"pid\":$cl," "$h/.claude/sessions/$cl.json" || no "claude registry for $cl"
ro=$(ls "$h"/.codex/sessions/*/*/*/rollout-*.jsonl 2> /dev/null | head -n 1)
[ -n "$ro" ] || no "no codex rollout"
if [ "$(uname -s)" = Linux ]; then held=$(ls -l "/proc/$cx/fd" 2> /dev/null | grep -c "rollout-" || true)
else held=$(lsof -p "$cx" 2> /dev/null | grep -c "rollout-" || true); fi
[ "${held:-0}" -ge 1 ] || no "codex $cx does not hold its rollout open"
ls "$h"/.claude/projects/-hist/*.jsonl 2> /dev/null | wc -l | grep -q '^ *5$' || no "5 history sessions"
[ "$(wc -l < "$t/pids" | tr -d ' ')" = 5 ] || no "pids file: $(wc -l < "$t/pids") lines"
for p in $cl $cx $gm; do
  k=$(ps -axo pid=,ppid= | awk -v p="$p" '$2 == p' | wc -l | tr -d ' ')
  [ "$k" -ge 2 ] || no "agent $p has $k children"
done
tr=$(ls "$h"/.claude/projects/-w-p1/*.jsonl); s0=$(wc -c < "$tr")
sleep 3
[ "$(wc -c < "$tr")" -gt "$s0" ] || no "claude transcript did not grow"
kids() { ps -axo pid=,ppid= | awk -v l=" $* " 'index(l, " " $2 " ") { print $1 }'; }
c1=$(kids $cl $cx $gm); all="$(cat "$t/pids") $c1 $(kids $c1)" # agents, their children, the exec chain's sleep
sh "$here/scripts/fixture-agents.sh" stop "$t"
for p in $all; do ! kill -0 "$p" 2> /dev/null || no "pid $p still alive after stop"; done
[ $fail = 0 ] && echo "fixture agents: all checks passed"
exit $fail
