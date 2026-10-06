#!/bin/sh
# TUI footprint of one agentglass binary on this host's real transcripts: first frame, RSS, CPU (self + children).
#   sh scripts/footprint.sh --bin <path> (--cold | --warm <cache dir>) [--warmup 30] [--window 120] [--scratch <dir>]
#                           [--config <config.json>] [--home <dir>] [--debug] [--away]
# Prints: first_frame_ms, rss_mb_5s, rss_mb_30s, rss_mb_end, cpu_self_pct, cpu_children_pct, cpu_total_pct (one per line,
# CPU in % of one core over the window after the warm-up). Runs the TUI niced in a detached 160x45 tmux pane with every
# AGENTGLASS_* path in the scratch dir and AGENTGLASS_AGENT=0; --warm copies the cache first (the original is never
# written); --config copies a config.json in (e.g. a pinned filter); --debug sets AGENTGLASS_DEBUG_REFRESH=1 and prints
# the pane's last row (the debug footer) as `debug <text>`; --away reports a focus-out to the TUI after its first frame
# (the terminal's focus event: nobody looks); --home runs it on a fixture HOME (scripts/fixture-agents.sh). Linux (/proc)
# and macOS (ps -S: self plus its waited-for children). Kills only its own tmux session.
set -e
export LC_ALL=C # decimal points in awk/sleep whatever the locale
os=$(uname -s); [ "$os" = Linux ] || [ "$os" = Darwin ] || { echo "footprint.sh: Linux or macOS only"; exit 2; }
usage() { echo "usage: sh scripts/footprint.sh --bin <path> (--cold | --warm <cache dir>) [--warmup 30] [--window 120] [--scratch <dir>] [--config <file>] [--home <dir>] [--debug] [--away]" >&2; exit 2; }
bin=""; mode=""; warm=""; warmup=30; window=120; scratch=""; config=""; home=""; debug=0; away=0
while [ $# -gt 0 ]; do
  case "$1" in
    --bin) bin=$2; shift ;;
    --cold) mode=cold ;;
    --warm) mode=warm; warm=$2; shift ;;
    --warmup) warmup=$2; shift ;;
    --window) window=$2; shift ;;
    --scratch) scratch=$2; shift ;;
    --config) config=$2; shift ;;
    --home) home=$2; shift ;;
    --debug) debug=1 ;;
    --away) away=1 ;;
    *) usage ;;
  esac
  shift
done
[ -n "$bin" ] && [ -x "$bin" ] && [ -n "$mode" ] || usage
[ "$mode" = cold ] || [ -d "$warm" ] || { echo "footprint.sh: no cache dir $warm" >&2; exit 2; }
command -v tmux > /dev/null || { echo "footprint.sh: needs tmux" >&2; exit 2; }
bin=$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")
own=0; if [ -z "$scratch" ]; then scratch=$(mktemp -d); own=1; fi
mkdir -p "$scratch"; scratch=$(cd "$scratch" && pwd)
rm -rf "$scratch/cache" "$scratch/run" "$scratch/otlp" "$scratch/config.json"; mkdir -p "$scratch/cache"
[ "$mode" = cold ] || cp -R "$warm/." "$scratch/cache/"
[ -z "$config" ] || cp "$config" "$scratch/config.json"
ses="agfp-$$"
cleanup() { tmux kill-session -t "$ses" 2> /dev/null || true; [ $own = 0 ] || rm -rf "$scratch"; }
trap cleanup EXIT INT TERM

if [ "$os" = Linux ]; then
  ms() { date +%s%3N; }
  hz=$(getconf CLK_TCK)
  rss() { awk '/^VmRSS:/ { printf "%d", $2 / 1024 }' "/proc/$pid/status" 2> /dev/null || echo -1; }
  # utime stime cutime cstime: fields 14-17 of /proc/<pid>/stat; comm (field 2) may hold spaces, so count after its ")"
  ticks() { sed 's/.*) //' "/proc/$pid/stat" | awk '{ print $12 + $13, $14 + $15 }'; }
  alive() { [ -r "/proc/$pid/stat" ] || { echo "footprint.sh: agentglass exited (pid $pid)" >&2; exit 1; }; }
else # BSD date has no %N; cpu self + waited-for children in ms from proc_pid_rusage (scripts/proc-cpu.c: ps -S does
  # not count the children on macOS)
  ms() { perl -MTime::HiRes=time -e 'printf "%d", time * 1000'; }
  hz=1000
  cc -O2 -Wall -Wextra -Werror -o "$scratch/proc-cpu" "$(dirname "$0")/proc-cpu.c"
  rss() { r=$(ps -o rss= -p "$pid" 2> /dev/null | tr -d ' '); [ -n "$r" ] && echo $((r / 1024)) || echo -1; }
  ticks() { "$scratch/proc-cpu" "$pid"; }
  alive() { kill -0 "$pid" 2> /dev/null || { echo "footprint.sh: agentglass exited (pid $pid)" >&2; exit 1; }; }
fi
dbg=""; [ $debug = 0 ] || dbg="AGENTGLASS_DEBUG_REFRESH=1"
hm=""; [ -z "$home" ] || hm="HOME='$(cd "$home" && pwd)'"
t0=$(ms)
pid=$(tmux new-session -d -P -F '#{pane_pid}' -s "$ses" -x 160 -y 45 \
  "exec env AGENTGLASS_CACHE_DIR='$scratch/cache' AGENTGLASS_CONFIG='$scratch/config.json' AGENTGLASS_RULES='$scratch/rules.json' \
   AGENTGLASS_RUN_DIR='$scratch/run' AGENTGLASS_PALETTE_FILE='$scratch/palette.json' AGENTGLASS_THEME_FILE='$scratch/theme' \
   AGENTGLASS_OTLP_DIR='$scratch/otlp' AGENTGLASS_PRICES='$scratch/prices.json' AGENTGLASS_AGENT=0 AGENTGLASS_NOTIFY=0 $hm $dbg nice -n 10 '$bin'")

first=-1
while [ $(($(ms) - t0)) -lt 60000 ]; do
  alive
  if tmux capture-pane -p -t "$ses" 2> /dev/null | grep -q '─ sessions'; then first=$(($(ms) - t0)); break; fi
  sleep 0.05
done
[ $first -ge 0 ] || { echo "footprint.sh: no first frame within 60 s" >&2; exit 1; }
[ $away = 0 ] || tmux send-keys -t "$ses" -l "$(printf '\033[O')" # focus out, as a terminal reports it
# until <s>: sleep until s seconds after the start
until_s() { d=$(($1 * 1000 - ($(ms) - t0))); [ $d -le 0 ] || sleep "$(awk -v d="$d" 'BEGIN { printf "%.3f", d / 1000 }')"; alive; }
r5=-1; r30=-1; c0=""; w0=0
for ev in $(printf '%s\n' "5 r5" "30 r30" "$warmup c0" | sort -n | tr ' ' ':'); do
  s=${ev%%:*}; what=${ev#*:}; until_s "$s"
  case "$what" in r5) r5=$(rss) ;; r30) r30=$(rss) ;; c0) c0=$(ticks); w0=$(ms) ;; esac
done
until_s $((warmup + window))
c1=$(ticks); w1=$(ms); rend=$(rss)
last=""; [ $debug = 0 ] || last=$(tmux capture-pane -p -t "$ses" | sed '/^[[:space:]]*$/d' | tail -n 1)
echo "first_frame_ms $first"
echo "rss_mb_5s $r5"
echo "rss_mb_30s $r30"
echo "rss_mb_end $rend"
echo "$c0 $c1" | awk -v hz="$hz" -v sec="$(((w1 - w0)))" '{
  s = ($3 - $1) / hz / (sec / 1000) * 100; c = ($4 - $2) / hz / (sec / 1000) * 100
  printf "cpu_self_pct %.2f\ncpu_children_pct %.2f\ncpu_total_pct %.2f\n", s, c, s + c }'
[ $debug = 0 ] || echo "debug $last"
