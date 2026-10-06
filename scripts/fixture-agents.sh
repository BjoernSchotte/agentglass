#!/bin/sh
# fake agents on a fixture HOME for footprint and parity runs (scripts/fake-agent.c), Linux and macOS; synthetic data only.
#   sh scripts/fixture-agents.sh start <dir> [--agents 12] [--history 300] [--background 300]
#   sh scripts/fixture-agents.sh stop <dir>
# start: builds fake-agent into <dir>/bin, writes <dir>/home (the transcript shapes of agent-mode.test.sh) and starts n
# agents round-robin claude / codex / gemini, each in its project <home>/w/p<i> (a git dir) with 2 children and an
# exec chain (sh → sleep), streaming a line to its transcript every 2 s; every fourth burns 5 % of a core. Claude links
# by its registry (~/.claude/sessions/<pid>.json), Codex by its held-open rollout, Gemini (node …/gemini.js) by its cwd.
# --history n older Claude sessions (2–30 days), --background n plain `sleep` processes (a desktop-sized process table).
# Prints `agents <n> pids <m>`; <dir>/pids lists every pid started, <dir>/agents the agents'. stop kills exactly those
# (an agent takes its process group with it) and waits up to 5 s.
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
usage() { echo "usage: sh scripts/fixture-agents.sh (start <dir> [--agents n] [--history n] [--background n] | stop <dir>)" >&2; exit 2; }
[ $# -ge 2 ] || usage
cmd=$1; dir=$2; shift 2

if [ "$cmd" = stop ]; then
  [ -f "$dir/pids" ] || exit 0
  for p in $(cat "$dir/agents" 2> /dev/null); do kill -TERM -- "-$p" 2> /dev/null || true; done # its group: children too
  for p in $(cat "$dir/pids"); do kill -TERM "$p" 2> /dev/null || true; done
  i=0; while [ $i -lt 50 ]; do
    left=""; for p in $(cat "$dir/pids"); do ! kill -0 "$p" 2> /dev/null || left="$left $p"; done
    [ -n "$left" ] || break; sleep 0.1; i=$((i + 1))
  done
  for p in $left; do kill -KILL "$p" 2> /dev/null || true; done
  rm -f "$dir/pids" "$dir/agents"
  exit 0
fi
[ "$cmd" = start ] || usage
agents=12; history=300; background=300
while [ $# -gt 0 ]; do
  case "$1" in
    --agents) agents=$2; shift ;;
    --history) history=$2; shift ;;
    --background) background=$2; shift ;;
    *) usage ;;
  esac
  shift
done
mkdir -p "$dir/bin/gemini"; dir=$(cd "$dir" && pwd -P) # physical: a process cwd reads as its real path (macOS /private/var)
h="$dir/home"; b="$dir/bin"; : > "$dir/pids"; : > "$dir/agents"
cc -O2 -Wall -Wextra -Werror -o "$b/fake-agent" "$here/scripts/fake-agent.c"
for n in claude codex node; do ln -sf fake-agent "$b/$n"; done
: > "$b/gemini/gemini.js"

# portable (GNU + BSD) dates from epoch seconds
fmt() { date -u -d "@$1" "+$2" 2> /dev/null || date -u -r "$1" "+$2"; }
iso() { fmt "$1" '%Y-%m-%dT%H:%M:%S.000Z'; }
uid() { printf 'f1c7%04x-0000-4000-8000-%012d' "$1" "$2"; } # kind, index
now=$(date +%s)
cline() { # cline <id> <cwd> <iso> <role>: a Claude transcript line
  if [ "$4" = user ]; then printf '{"type":"user","sessionId":"%s","cwd":"%s","timestamp":"%s","message":{"role":"user","content":"build the todo app"}}' "$1" "$2" "$3"
  else printf '{"type":"assistant","sessionId":"%s","cwd":"%s","timestamp":"%s","message":{"id":"m-%s","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1000,"output_tokens":100}}}' "$1" "$2" "$3" "$1" "$3"; fi
}

# history: n Claude sessions, 2–30 days old
hd="$h/.claude/projects/-hist"; mkdir -p "$hd"
i=1; while [ "$i" -le "$history" ]; do
  at=$((now - (2 + i % 29) * 86400 - i * 7)); id=$(uid 1 "$i"); f="$hd/$id.jsonl"
  { cline "$id" "$h/w/hist" "$(iso "$at")" user; echo; cline "$id" "$h/w/hist" "$(iso $((at + 5)))" assistant; echo; } > "$f"
  touch -t "$(fmt $((at + 5)) '%Y%m%d%H%M')" "$f"
  i=$((i + 1))
done

i=1; while [ "$i" -le "$agents" ]; do
  p="$h/w/p$i"; mkdir -p "$p/.git"; t0=$(iso "$(date +%s)")
  busy=""; [ $((i % 4)) != 0 ] || busy="--busy 5"
  case $((i % 3)) in
    1) id=$(uid 2 "$i"); tr="$h/.claude/projects/-w-p$i/$id.jsonl"; mkdir -p "$(dirname "$tr")"
       { cline "$id" "$p" "$t0" user; echo; } > "$tr"
       (cd "$p" && exec "$b/claude" --children 2 --grandchild --append "$tr" --every 2 --line "$(cline "$id" "$p" "$t0" assistant)" $busy) < /dev/null > /dev/null 2>&1 &
       pid=$!; mkdir -p "$h/.claude/sessions"
       printf '{"pid":%s,"sessionId":"%s","cwd":"%s","startedAt":%s000,"status":"busy","name":"fixture %s"}\n' "$pid" "$id" "$p" "$now" "$i" > "$h/.claude/sessions/$pid.json" ;;
    2) id=$(uid 3 "$i"); xd="$h/.codex/sessions/$(date +%Y/%m/%d)"; mkdir -p "$xd"; tr="$xd/rollout-$(date +%Y-%m-%dT%H-%M-%S)-$id.jsonl"
       printf '{"timestamp":"%s","type":"session_meta","payload":{"id":"%s","cwd":"%s","timestamp":"%s","originator":"codex_cli_rs"}}\n' "$t0" "$id" "$p" "$t0" > "$tr"
       line=$(printf '{"timestamp":"%s","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}' "$t0")
       (cd "$p" && exec "$b/codex" --children 2 --grandchild --open "$tr" --append "$tr" --every 2 --line "$line" $busy) < /dev/null > /dev/null 2>&1 &
       pid=$! ;;
    0) id=$(printf '9e3%05d-0000-4000-8000-%012d' "$i" "$i"); gd="$h/.gemini/tmp/p$i"; mkdir -p "$gd/chats"; printf '%s\n' "$p" > "$gd/.project_root"
       tr="$gd/chats/session-$(date -u +%Y-%m-%dT%H-%M)-$(printf %08d "$i").jsonl"
       line=$(printf '{"id":"g%s","timestamp":"%s","type":"gemini","content":"ok","model":"gemini-2.5-flash","tokens":{"input":10,"output":5,"cached":0}}' "$i" "$t0")
       (cd "$p" && exec "$b/node" "$b/gemini/gemini.js" --children 2 --grandchild --append "$tr" --every 2 --line "$line" $busy) < /dev/null > /dev/null 2>&1 &
       pid=$!
       # begun after its process (live linking by cwd takes sessions begun since the process started)
       t1=$(iso "$(date +%s)")
       { printf '{"sessionId":"%s","projectHash":"ab","startTime":"%s","lastUpdated":"%s","kind":"main"}\n' "$id" "$t1" "$t1"
         printf '{"id":"u%s","timestamp":"%s","type":"user","content":[{"text":"build the todo app"}]}\n' "$i" "$t1"; } > "$tr" ;;
  esac
  echo "$pid" >> "$dir/pids"; echo "$pid" >> "$dir/agents"
  i=$((i + 1))
done
i=0; while [ "$i" -lt "$background" ]; do sleep 3600 < /dev/null > /dev/null 2>&1 & echo $! >> "$dir/pids"; i=$((i + 1)); done
echo "agents $agents pids $(wc -l < "$dir/pids" | tr -d ' ')"
