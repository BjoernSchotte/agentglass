#!/bin/sh
# Golden comparison of two agentglass binaries on this host's real transcripts: tokens, costs, tool and line counts,
# skills, billing, the sessions matching three call-row filters and `cost --by session` rows must be identical.
#   sh scripts/golden-usage.sh --ref <bin> --new <bin> (--cold | --warm) [--harness h] [--scratch <dir>]
# --cold: both binaries index from empty caches (ref first). --warm: ref indexes cold into cache A, A is copied to B
# right after (ref's own cache format), and the new binary runs on B (exercises load, migration and lazy call rows).
# Only stable sessions count: listed by both runs, same bytes, last write over 120 s before the ref run started (live
# agents keep writing while this runs). Prints `compared <n> stable sessions, skipped <m>`, one line per difference
# (`<session> <field> ref=<v> new=<v>`), then `<k> differences`; exit 0 iff k = 0. Every AGENTGLASS_* path points into
# the scratch dir; only ids, numbers and paths are compared and printed (no transcript text).
# GOLDEN_SELFTEST=1 adds 1 to the first stable session's tokens.in in the new output (the script must then fail).
set -e
usage() { echo "usage: sh scripts/golden-usage.sh --ref <bin> --new <bin> (--cold | --warm) [--harness h] [--scratch <dir>]" >&2; exit 2; }
ref=""; new=""; mode=""; harness=""; scratch=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) ref=$2; shift ;;
    --new) new=$2; shift ;;
    --cold) mode=cold ;;
    --warm) mode=warm ;;
    --harness) harness=$2; shift ;;
    --scratch) scratch=$2; shift ;;
    *) usage ;;
  esac
  shift
done
[ -x "$ref" ] && [ -x "$new" ] && [ -n "$mode" ] || usage
command -v python3 > /dev/null || { echo "golden-usage.sh: needs python3" >&2; exit 2; }
own=0; if [ -z "$scratch" ]; then scratch=$(mktemp -d); own=1; fi
mkdir -p "$scratch"; scratch=$(cd "$scratch" && pwd)
[ $own = 0 ] || trap 'rm -rf "$scratch"' EXIT
rm -rf "$scratch/ref" "$scratch/new"; mkdir -p "$scratch/ref/cache" "$scratch/new/cache"

FIELDS=id,harness,path,bytes,updated,tokens,costUsd,unpricedTokens,unpricedCredits,tools,linesAdded,linesRemoved,skills,billing
# ag <side> <bin> args…: one isolated run (its own cache, config, rules, run dir, …; human mode, no network)
ag() {
  d="$scratch/$1"; b=$2; shift 2
  env AGENTGLASS_CACHE_DIR="$d/cache" AGENTGLASS_CONFIG="$d/config.json" AGENTGLASS_RULES="$d/rules.json" \
    AGENTGLASS_RUN_DIR="$d/run" AGENTGLASS_PALETTE_FILE="$d/palette.json" AGENTGLASS_THEME_FILE="$d/theme" \
    AGENTGLASS_OTLP_DIR="$d/otlp" AGENTGLASS_PRICES="$d/prices.json" AGENTGLASS_AGENT=0 AGENTGLASS_NOTIFY=0 AGENTGLASS_OFFLINE=1 nice -n 10 "$b" "$@"
}
hf=""; [ -z "$harness" ] || hf="--harness $harness"
# runs <side> <bin>: the list first (on a cold cache it indexes), then the filters and cost rows
runs() {
  # shellcheck disable=SC2086
  ag "$1" "$2" --json --subagents $hf --format jsonl --fields "$FIELDS" > "$scratch/$1/list.jsonl"
  [ "$1:$mode" != ref:warm ] || cp -R "$scratch/ref/cache/." "$scratch/new/cache/"
  i=0
  for f in 'status is error' 'tool is Bash' 'duration > 30s'; do
    i=$((i + 1))
    # shellcheck disable=SC2086
    ag "$1" "$2" --json --subagents $hf --format jsonl --fields harness,id,path --filter "$f" > "$scratch/$1/filter$i.jsonl"
  done
  # shellcheck disable=SC2086
  ag "$1" "$2" cost --json --by session --since 30d $hf > "$scratch/$1/cost.json"
}
start=$(date +%s)
runs ref "$ref"
runs new "$new"

python3 - "$scratch" "$start" "${GOLDEN_SELFTEST:-0}" << 'PY'
import json, sys
from datetime import datetime
d, start, selftest = sys.argv[1], int(sys.argv[2]), sys.argv[3] == "1"
def jl(p):
    with open(p) as f: return [json.loads(l) for l in f if l.strip()]
def ts(s):
    try: return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception: return float("inf")
ref = {o["path"]: o for o in jl(d + "/ref/list.jsonl")}
new = {o["path"]: o for o in jl(d + "/new/list.jsonl")}
stable = sorted(p for p, o in ref.items() if p in new and new[p]["bytes"] == o["bytes"] and ts(o["updated"]) < start - 120)
skipped = len(set(ref) | set(new)) - len(stable)
if selftest and stable:
    t = new[stable[0]].get("tokens") or {}; t["in"] = (t.get("in") or 0) + 1; new[stable[0]]["tokens"] = t
diffs = []
def canon(v): return json.dumps(v, sort_keys=True, separators=(",", ":"))
def name(p): o = ref[p]; return o["harness"] + ":" + o["id"]
FIELDS = ["tokens", "costUsd", "unpricedTokens", "unpricedCredits", "tools", "linesAdded", "linesRemoved", "skills", "billing"]
for p in stable:
    for k in FIELDS:
        a, b = ref[p].get(k), new[p].get(k)
        if canon(a) != canon(b): diffs.append("%s %s ref=%s new=%s" % (name(p), k, canon(a), canon(b)))
st = set(stable)
for i, f in enumerate(["status is error", "tool is Bash", "duration > 30s"], 1):
    a = {o["path"] for o in jl(d + "/ref/filter%d.jsonl" % i)} & st
    b = {o["path"] for o in jl(d + "/new/filter%d.jsonl" % i)} & st
    for p in sorted(a - b): diffs.append("%s filter[%s] ref=match new=no" % (name(p), f))
    for p in sorted(b - a): diffs.append("%s filter[%s] ref=no new=match" % (name(p), f))
# cost rows are keyed harness:id; an id two stable sessions share is ambiguous and skipped
keys = {}
for p in stable: keys.setdefault(name(p), []).append(p)
ok = {k for k, v in keys.items() if len(v) == 1}
def rows(side):
    with open(d + "/" + side + "/cost.json") as f: return {r["key"]: r for r in json.load(f)["rows"] if r.get("key") in ok}
ra, rb = rows("ref"), rows("new")
for k in sorted(set(ra) | set(rb)):
    a, b = ra.get(k), rb.get(k)
    if a is None or b is None: diffs.append("%s cost-row ref=%s new=%s" % (k, "row" if a else "none", "row" if b else "none")); continue
    for f in ["in", "out", "cacheRead", "cacheWrite", "costUsd", "unpricedTokens", "sessions"]:
        if canon(a.get(f)) != canon(b.get(f)): diffs.append("%s cost.%s ref=%s new=%s" % (k, f, canon(a.get(f)), canon(b.get(f))))
print("compared %d stable sessions, skipped %d" % (len(stable), skipped))
for x in diffs: print(x)
print("%d differences" % len(diffs))
sys.exit(1 if diffs else 0)
PY
