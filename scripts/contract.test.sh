#!/bin/sh
# the CLI contract (docs/cli-contract.md) on a fake HOME: every listed command, field (with its type), exit code and
# --help --json field list. A failure here means a contract change: bump CONTRACT (src/features/version.ts) and the doc.
# sh scripts/contract.test.sh
set -e
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
command -v python3 > /dev/null 2>&1 || { echo "contract: skipped (needs python3)"; exit 0; }
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/ag"; else AGENTGLASS_OUT="$t/ag" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
h="$t/h"; p1="$h/w/p1"; p2="$h/w/p2"; mkdir -p "$p1/.git" "$p2/.git"
A=abcdef01-0000-4000-8000-000000000001; B=abcdef02-0000-4000-8000-000000000002
day=$(date -u +%Y-%m-%d)
cl() { # cl <project dir> <session id> <cwd>: a Claude session of today with one priced turn
  mkdir -p "$1"
  { printf '{"type":"user","sessionId":"%s","cwd":"%s","timestamp":"%sT00:00:01.000Z","message":{"role":"user","content":"hello"}}\n' "$2" "$3" "$day"
    printf '{"type":"assistant","sessionId":"%s","cwd":"%s","timestamp":"%sT00:00:02.000Z","message":{"id":"m1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":1000,"output_tokens":100}}}\n' "$2" "$3" "$day"; } > "$1/$2.jsonl"
}
cl "$h/.claude/projects/-w-p1" "$A" "$p1"
cl "$h/.claude/projects/-w-p1" "$B" "$p1"
# a resumed session copied into a second project dir: the same id twice; the copy written last is the session
cl "$h/.claude/projects/-w-p2" "$B" "$p2"
touch -t "$(date +%Y%m%d)0001" "$h/.claude/projects/-w-p1/$B.jsonl"
run() { env -i HOME="$h" PATH="$PATH" AGENTGLASS_CACHE_DIR="$t/cache" AGENTGLASS_CONFIG="$t/config.json" AGENTGLASS_RULES=/nonexistent \
  AGENTGLASS_NOTIFY=0 AGENTGLASS_OFFLINE=1 AGENTGLASS_AGENT=0 AGENTGLASS_HERDR=off "$t/ag" "$@"; }
# types <file> <field:type,…>: every row (a JSON object or a list of them) has each field with that type
types() {
  python3 - "$@" << 'PY'
import json, sys
d = json.load(open(sys.argv[1])); rows = d if isinstance(d, list) else d["rows"] if isinstance(d, dict) and isinstance(d.get("rows"), list) else [d]
ok = {"string": lambda v: isinstance(v, str), "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
      "bool": lambda v: isinstance(v, bool), "array": lambda v: isinstance(v, list),
      "object|null": lambda v: v is None or isinstance(v, dict), "string|null": lambda v: v is None or isinstance(v, str),
      "number|null": lambda v: v is None or (isinstance(v, (int, float)) and not isinstance(v, bool))}
bad = []
if not rows: bad.append("no rows")
for r in rows:
    for ft in sys.argv[2].split(","):
        f, ty = ft.split(":")
        if f not in r: bad.append(f + " missing")
        elif not ok[ty](r[f]): bad.append(f + " is " + type(r[f]).__name__ + ", want " + ty)
print("; ".join(sorted(set(bad))) or "ok")
PY
}
# helped <cmd> <f,…>: --help --format json lists each field for that command
helped() {
  run --help --format json > "$t/help.json"
  python3 - "$t/help.json" "$1" "$2" << 'PY'
import json, sys
cs = [c for c in json.load(open(sys.argv[1]))["commands"] if c["cmd"] == sys.argv[2]]
miss = [f for f in sys.argv[3].split(",") if not cs or f not in cs[0]["fields"]]
print("missing " + ",".join(miss) if miss else "ok")
PY
}

# --version --json
run --version --json > "$t/v.json"
eq "version types" "$(types "$t/v.json" version:string,contract:number)" ok
eq "contract" "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["contract"])' "$t/v.json")" 1
eq "version help" "$(helped --version version,contract)" ok

# --json: the fields, typed (json and jsonl), csv headers incl. the flattened mux columns, the help list
SF="id:string,harness:string,title:string,cwd:string,live:bool,pid:number,status:string,costUsd:number|null,attention:bool,stuck:string|null,alerts:array"
SF="$SF,mux:object|null"
FL=$(printf %s "$SF" | sed 's/:[a-z|]*//g')
run --json --all-projects --limit 5 --fields "$FL" --format json > "$t/j.json"
eq "--json types" "$(types "$t/j.json" "$SF")" ok
run --json --all-projects --limit 5 --fields "$FL" --format jsonl | head -1 > "$t/j1.json"
eq "--json jsonl types" "$(types "$t/j1.json" "$SF")" ok
eq "--json live" "$(run --json --live --all-projects --fields id --format json)" "[]"
eq "--json help" "$(helped --json "$FL")" ok
MF=id,harness,mux_kind,mux_pane,mux_workspace,mux_tab,mux_status
eq "--json csv header" "$(run --json --all-projects --limit 1 --fields "$MF" --format csv | head -1)" "$MF"
eq "--json csv live header" "$(run --json --live --all-projects --fields "$MF" --format csv | head -1)" "$MF"
eq "--json filter" "$(run --json --all-projects --filter "id is $A" --fields id --format csv | tail -n +2)" "$A"

# session <ref>: the same fields; a full ref with two copies → the newest copy; exit codes 3, 4, 2
run session "claude:$A" --fields "$FL" --format json > "$t/s.json"
eq "session types" "$(types "$t/s.json" "$SF")" ok
eq "session full ref with copies" "$(run session "claude:$B" --fields cwd --format csv | tail -n +2)" "$p2"
eq "session full id with copies" "$(run session "$B" --fields cwd --format csv | tail -n +2)" "$p2"
eq "session help" "$(helped session "$FL")" ok
set +e
run session zzzzzzzz > /dev/null 2>&1; eq "session not found" $? 3
run session abcdef0 > /dev/null 2>&1; eq "session ambiguous prefix" $? 4
run session abc > /dev/null 2>&1; eq "session prefix too short" $? 2
set -e

# cost rows
for by in project harness; do
  run cost --since today --by $by --format json --fields key,costUsd > "$t/c.json"
  eq "cost --by $by types" "$(types "$t/c.json" key:string,costUsd:number)" ok
done
for since in 7d 30d; do eq "cost --since $since" "$(run cost --since $since --by harness --format csv --fields key | tail -n +2 | tr '\n' ' ')" "claude total "; done
run cost --since today --by workspace --format json --fields key,workspaceId,costUsd > "$t/c.json"
eq "cost --by workspace types" "$(types "$t/c.json" key:string,workspaceId:string\|null,costUsd:number)" ok
eq "cost help" "$(helped cost key,costUsd)" ok
eq "cost help workspaceId" "$(helped cost workspaceId)" ok

# open: in a pipe it prints the resolution; exit codes 0, 3, 4, 2
set +e
run open "claude:$A" --new-instance > /dev/null 2>&1; eq "open exit" $? 0
run open "agentglass://open/claude/$A" --new-instance > /dev/null 2>&1; eq "open url exit" $? 0
run open "claude:$B" > /dev/null 2>&1; eq "open full ref with copies" $? 0
run open zzzzzzzz --new-instance > /dev/null 2>&1; eq "open not found" $? 3
run open abcdef0 > /dev/null 2>&1; eq "open ambiguous" $? 4
run open "agentglass://nope" > /dev/null 2>&1; eq "open malformed" $? 2
set -e

# the notify command's alert JSON: the listed fields (rules check accepts the documented shape)
printf '{"notify":{"command":["/bin/cat"],"on":["fire","escalate"]}}' > "$t/rules.json"; chmod 600 "$t/rules.json"
set +e; env -i HOME="$h" PATH="$PATH" AGENTGLASS_RULES="$t/rules.json" AGENTGLASS_AGENT=0 "$t/ag" rules check > /dev/null 2>&1; rc=$?; set -e
eq "notify.command shape" "$rc" 0
grep -q 'rule: string; severity: string; state: string;' "$here/src/features/rules/notify.ts" 2>/dev/null || [ ! -d "$here/src" ] || { echo "FAIL notify JAlert lost a contract field"; fail=1; }
for f in session harness message title project; do grep -q " $f: string;" "$here/src/features/rules/notify.ts" 2>/dev/null || [ ! -d "$here/src" ] || { echo "FAIL notify JAlert lost $f"; fail=1; }; done

[ $fail = 0 ] && echo "contract: all checks passed"
exit $fail
