#!/bin/sh
# agentglass open <trace id>[/<span id>] against the OTLP export's golden traces of all seven harnesses: every trace id
# leads to its session and turn, every span id to its call / request / subagent, with no warning: sh scripts/open-trace.test.sh
set -e
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
command -v python3 > /dev/null 2>&1 || { echo "open-trace: skipped (needs python3)"; exit 0; }
AGENTGLASS_OUT="$t/ag" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }
sh "$here/scripts/build-info.sh"
fail=0; total=0
for h in claude codex gemini opencode pi kiro fx; do
  home="$t/$h"; mkdir -p "$home"; cp -R "$here/testdata/otlp/fixtures/$h/." "$home/"
  db=""; if [ "$h" = opencode ]; then
    command -v sqlite3 > /dev/null 2>&1 || { echo "open-trace: opencode skipped (needs sqlite3)"; continue; }
    db="$t/opencode.db"; sqlite3 "$db" < "$here/testdata/otlp/fixtures/opencode/opencode.sql"
  fi
  find "$home" -type f -exec touch -t 202609011100 {} +
  # one line per span: the args to open, then what --print must show
  python3 - "$here/testdata/otlp/golden-$h.json" > "$t/cases" << 'PY'
import json, sys
d = json.load(open(sys.argv[1]))
spans = [sp for rs in d["resourceSpans"] for ss in rs["scopeSpans"] for sp in ss["spans"]]
byid = {sp["spanId"]: sp for sp in spans}
def attrs(sp): return {a["key"]: list(a["value"].values())[0] for a in sp["attributes"]}
for sp in spans:
    a = attrs(sp); conv = a.get("gen_ai.conversation.id", "")
    if not sp.get("parentSpanId"):
        print(sp["traceId"], "root", conv, a.get("agentglass.turn.index", ""))
        print(sp["traceId"] + "/" + sp["spanId"], "root", conv, a.get("agentglass.turn.index", ""))
    elif a.get("gen_ai.operation.name") == "execute_tool" and a.get("gen_ai.tool.call.id"):
        print(sp["traceId"] + "/" + sp["spanId"], "tool", conv, a["gen_ai.tool.call.id"])
    elif a.get("gen_ai.operation.name") == "invoke_agent":
        print(sp["traceId"] + "/" + sp["spanId"], "sub", conv, "-")
    else:
        print(sp["traceId"] + "/" + sp["spanId"], "any", conv, "-")
PY
  n=0
  while read -r ref kind conv want; do
    n=$((n + 1)); total=$((total + 1))
    out=$(env -i HOME="$home" PATH="$PATH" TZ=UTC OPENCODE_DB="$db" AGENTGLASS_CACHE_DIR="$t/cache-$h" AGENTGLASS_CONFIG="$t/none.json" \
      AGENTGLASS_RULES=/nonexistent AGENTGLASS_NOTIFY=0 AGENTGLASS_OFFLINE=1 "$t/ag" open "$ref" --print 2> "$t/err") || { echo "FAIL $h $kind $ref: exit $? $(cat "$t/err")"; fail=1; continue; }
    [ -s "$t/err" ] && { echo "FAIL $h $kind $ref warned: $(cat "$t/err")"; fail=1; }
    got=$(printf '%s' "$out" | python3 -c '
import json, sys
o = json.loads(sys.stdin.read()); a = o.get("anchor") or {}
print(o["harness"], o["id"], a.get("turn"), a.get("callId"), o["url"])')
    set -- $got
    case $kind in
      root) [ "$2" = "$conv" ] && [ "$3" = "$want" ] || { echo "FAIL $h root $ref: got $got, want $conv turn $want"; fail=1; }
        # the canonical link (#turn=<start ts>[~k]) lands on the same turn
        back=$(env -i HOME="$home" PATH="$PATH" TZ=UTC OPENCODE_DB="$db" AGENTGLASS_CACHE_DIR="$t/cache-$h" AGENTGLASS_CONFIG="$t/none.json" \
          AGENTGLASS_RULES=/nonexistent AGENTGLASS_NOTIFY=0 AGENTGLASS_OFFLINE=1 "$t/ag" open "$5" --print 2>&1 | python3 -c 'import json, sys; o = json.loads(sys.stdin.read()); print(o["id"], (o.get("anchor") or {}).get("turn"))' 2>&1)
        [ "$back" = "$2 $3" ] || { echo "FAIL $h root $ref: its url $5 gives $back"; fail=1; } ;;
      tool) [ "$4" = "$want" ] || { echo "FAIL $h tool $ref: got $got, want call $want"; fail=1; } ;;
      sub) [ "$2" != "$conv" ] || { echo "FAIL $h subagent $ref: landed on the root $got"; fail=1; } ;;
    esac
    case $5 in "agentglass://open/$h/"*) ;; *) echo "FAIL $h $ref: url $5"; fail=1 ;; esac
  done < "$t/cases"
  [ "$n" -gt 0 ] || { echo "FAIL $h: no spans in the golden"; fail=1; }
done
[ $fail = 0 ] && echo "open-trace: all goldens resolve ($total spans and traces)"
exit $fail
