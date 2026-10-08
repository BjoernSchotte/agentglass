#!/bin/sh
# agentglass-mcp's footprint (manual, not in check.sh; spec mcp-server Testing): n idle servers, then warm calls.
#   sh scripts/mcp-footprint.sh <bin-dir> <n> [<cwd>]
# <bin-dir> holds agentglass and agentglass-mcp (a release build: AGENTGLASS_OUT=<dir>/agentglass ./build.sh); run it
# with your isolation variables (AGENTGLASS_CACHE_DIR …) set, under nice. Linux only (/proc).
# 1. n servers, each under scripts/mcp-client.py (initialize, tools/list, then idle): Private_Dirty and Rss per server
#    at 5 s and 60 s, and the CPU ticks each used in between (budget: ≤ 1 MB, ≤ 4 MB, 0 ticks; spec: 36 ≤ 40 MB).
# 2. one server, 10 warm `session {"ref":"last"}` and 10 `contention {}` calls: wall p50/p95 per tool and the
#    server's own CPU per call (utime+stime; its children count in cutime) (budget: ≤ 1.5 s / ≤ 1 s p95, ≤ 5 ms).
set -e
dir=$(cd "${1:?usage: mcp-footprint.sh <bin-dir> <n> [cwd]}" && pwd); n=${2:-1}; cwd=${3:-$PWD}
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); clients=""
trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; for c in $clients; do kill "$c" 2>/dev/null || true; done; rm -rf "$t"' EXIT
[ -r /proc/self/smaps_rollup ] || { echo "mcp-footprint: needs Linux /proc" >&2; exit 1; }
init='{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"footprint","version":"1"}}}'
kb() { awk -v k="$2:" '$1 == k { print $2 }' "/proc/$1/smaps_rollup"; }
ticks() { awk '{ print $14 + $15 }' "/proc/$1/stat"; }
# 1. idle servers
{ echo "$init"; echo '{"wait":0}'; echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'; echo '{"wait":1}'; echo '{"sleep":62000}'; } > "$t/idle.jsonl"
i=0; while [ $i -lt "$n" ]; do
  python3 "$here/scripts/mcp-client.py" --cwd "$cwd" --timeout 90 -- "$dir/agentglass-mcp" < "$t/idle.jsonl" > "$t/idle.$i.out" 2>&1 &
  clients="$clients $!"; i=$((i + 1))
done
sleep 5
srv=""; for c in $clients; do s=$(pgrep -P "$c" | head -1); srv="$srv $s"; done
for s in $srv; do echo "$s $(kb "$s" Private_Dirty) $(kb "$s" Rss) $(ticks "$s")"; done > "$t/s5"
sleep 55
for s in $srv; do echo "$s $(kb "$s" Private_Dirty) $(kb "$s" Rss) $(ticks "$s")"; done > "$t/s60"
echo "idle servers: $n (5 s → 60 s)"
paste "$t/s5" "$t/s60" | awk '{ pd = $6; rss = $7; dt = $8 - $4; sum += pd; if (pd > mx) mx = pd; if (rss > mr) mr = rss; if (dt > md) md = dt
    printf "  pid %-8s Private_Dirty %5d KB  Rss %5d KB  CPU ticks %d\n", $1, pd, rss, dt }
  END { printf "  sum Private_Dirty %d KB (%.2f MB); max per server %d KB Private_Dirty, %d KB Rss, %d ticks\n", sum, sum / 1024, mx, mr, md }'
wait 2>/dev/null || true; clients=""
# 2. warm calls through one server
{ echo "$init"; echo '{"wait":0}'
  k=10; while [ $k -lt 30 ]; do
    if [ $k -lt 20 ]; then printf '{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":"session","arguments":{"ref":"last"}}}\n{"wait":%d}\n' $k $k
    else printf '{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":"contention","arguments":{}}}\n{"wait":%d}\n' $k $k; fi
    k=$((k + 1)); done
  echo '{"sleep":300}'; } > "$t/warm.jsonl"
python3 "$here/scripts/mcp-client.py" --cwd "$cwd" --timeout 300 -- "$dir/agentglass-mcp" < "$t/warm.jsonl" > "$t/warm.out" 2>&1 &
c=$!; clients=$c; sleep 0.3; s=$(pgrep -P "$c" | head -1); t0=$(ticks "$s")
while kill -0 "$c" 2>/dev/null && ! grep -q '"id":29' "$t/warm.out"; do sleep 0.2; done
t1=$(ticks "$s"); wait "$c" 2>/dev/null || true; clients=""
# a call's wall time: from the previous answer (the client sends the next request at once) to its own
python3 - "$t/warm.out" "$t0" "$t1" << 'PY'
import json, sys
ts = {}
for l in open(sys.argv[1]):
    p = l.rstrip("\n").split("\t", 1)
    if len(p) == 2 and p[0].isdigit():
        try: m = json.loads(p[1])
        except ValueError: continue
        if isinstance(m, dict) and "id" in m: ts[m["id"]] = int(p[0])
def stats(ids):
    w = sorted(ts[i] - ts[i - 1] for i in ids if i in ts and i - 1 in ts)
    return w[len(w) // 2] / 1000, w[min(len(w) - 1, int(len(w) * 0.95))] / 1000, len(w)
s, c = stats(range(11, 20)), stats(range(21, 30))
print("warm calls: session p50 %.2f s p95 %.2f s (%d); contention p50 %.2f s p95 %.2f s (%d)" % (s + c))
hz = 100; d = (int(sys.argv[3]) - int(sys.argv[2])) * 1000 / hz
print("server's own CPU: %.0f ms for 20 calls = %.1f ms per call (children excluded)" % (d, d / 20))
PY
