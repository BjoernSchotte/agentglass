#!/bin/sh
# agentglass events <ref> and --watch kinds on a fake HOME: kind filters, gap entries, --limit, text only with --content,
# exit codes; --watch --filter 'event.kind is skill' streams only skill events, each line with its kinds
set -e
cd "$(dirname "$0")/.."
. ./scripts/toolchain.sh
T=$(mktemp -d); trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; rm -rf "$T"' EXIT
BIN="$T/agentglass"; if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$BIN"; else scriptc build src/main.ts -o "$BIN" >/dev/null; fi
command -v python3 > /dev/null 2>&1 || { echo "events: skipped (needs python3)"; exit 0; }
H="$T/home"; W="$T/w"; mkdir -p "$H/.claude/projects/-w" "$W"
ID=e7e7e7e7-0000-4000-8000-000000000001; D=$(date -u +%Y-%m-%d)
C="$H/.claude/projects/-w/$ID.jsonl"
cl() { printf '%s\n' "$1" >> "$C"; }
u() { cl "{\"type\":\"user\",\"sessionId\":\"$ID\",\"cwd\":\"$W\",\"timestamp\":\"${D}T09:00:$1.000Z\",\"message\":{\"role\":\"user\",\"content\":\"$2\"}}"; }
call() { cl "{\"type\":\"assistant\",\"sessionId\":\"$ID\",\"cwd\":\"$W\",\"timestamp\":\"${D}T09:00:$1.000Z\",\"message\":{\"id\":\"m$2\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"$2\",\"name\":\"$3\",\"input\":$4}],\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}}"; }
res() { cl "{\"type\":\"user\",\"sessionId\":\"$ID\",\"cwd\":\"$W\",\"timestamp\":\"${D}T09:00:$1.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"$2\",\"content\":\"$3\"}]}}"; }
u 01 "SECRETPROMPT add a login form"
call 02 toolu_b1 Bash '{"command":"npm test"}'; res 03 toolu_b1 "Exit code 1"
call 04 toolu_s1 Skill '{"skill":"brainstorming"}'; res 05 toolu_s1 "loaded"
call 06 toolu_r1 Read '{"file_path":"/w/a.ts"}'; res 07 toolu_r1 "x"
call 08 toolu_m1 mcp__github__get_issue '{"number":1}'; res 09 toolu_m1 "body"
ag() { env -u CODEX_HOME -u PI_CODING_AGENT_DIR -u PI_CODING_AGENT_SESSION_DIR HOME="$H" AGENTGLASS_AGENT=0 AGENTGLASS_CACHE_DIR="$T/cache" AGENTGLASS_CONFIG="$T/config.json" \
  AGENTGLASS_RULES=/nonexistent AGENTGLASS_NOTIFY=0 AGENTGLASS_RUN_DIR="$T/run" AGENTGLASS_HERDR=off "$BIN" "$@"; }
fail() { echo "FAIL $1"; [ -f "$T/out" ] && cat "$T/out"; exit 1; }
py() { python3 -c "import json,sys; d=json.load(open('$T/out')); $1"; }

ag events claude:$ID --filter "event.kind is_one_of skill, error" --json > "$T/out" || fail "events exit $?"
[ "$(py 'print(d["matched"], d["total"])')" = "4 9" ] || fail "matched/total"
[ "$(py 'print(" ".join(("~" + str(e["gap"])) if "gap" in e else str(e["i"]) for e in d["events"]))')" = "~1 1 2 3 4 ~4" ] || fail "events and gaps"
[ "$(py 'print(json.dumps(d["events"][0]["kinds"]))')" = '{"prompt": 1}' ] || fail "gap kinds"
[ "$(py 'e=d["events"][1]; print(e["tool"], ",".join(e["kinds"]), e["target"], e["text"])')" = "Bash error,shell:test npm test None" ] || fail "an event"
[ "$(py 'print("SECRETPROMPT" in json.dumps(d["events"]))')" = False ] || fail "text without --content" # (the title is the session's, as in --json)
ag events claude:$ID --content --json > "$T/out" || fail "--content exit $?"
[ "$(py 'print("SECRETPROMPT" in json.dumps(d["events"]))')" = True ] || fail "--content shows the text"
ag events claude:$ID --preset mcp --json > "$T/out" || fail "--preset exit $?"
[ "$(py 'print(d["preset"], d["filter"], d["matched"])')" = "mcp event.kind is mcp 2" ] || fail "--preset mcp"
ag events claude:$ID --filter "event.kind is shell" --limit 1 --json > "$T/out" || fail "--limit exit $?"
[ "$(py 'print(" ".join(("~" + str(e["gap"])) if "gap" in e else str(e["i"]) for e in d["events"]))')" = "~2 2 ~6" ] || fail "--limit"
# errors: a bad expression exits 2 with a caret; an unknown session 3; text output on a terminal-less run is JSON
set +e
ag events claude:$ID --filter "event.kind is shel" > "$T/out" 2>"$T/err"; rc=$?
[ $rc = 2 ] && grep -q "shel" "$T/err" || { cat "$T/err"; fail "bad filter: exit $rc"; }
ag events claude:ffffffff-0000-4000-8000-000000000009 --json > "$T/out" 2>"$T/err"; rc=$?
[ $rc = 3 ] || { cat "$T/err"; fail "unknown session: exit $rc"; }
ag events claude:$ID --bogus > "$T/out" 2>"$T/err"; rc=$?
[ $rc = 2 ] || fail "unknown option: exit $rc"
set -e
# --watch: only skill events, each line with its kinds
ag --watch --from-start --for 4s --no-alerts --filter "event.kind is skill" > "$T/out" 2>"$T/err" || fail "--watch exit $?"
python3 - "$T/out" << 'PY' || fail "--watch lines"
import json, sys
ls = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
assert len(ls) == 2, ls
assert all("skill:load" in l["kinds"] for l in ls), ls
assert [l["kind"] for l in ls] == ["tool", "result"], ls
PY
ag --watch --from-start --for 4s --no-alerts > "$T/out" 2>"$T/err" || fail "--watch (all) exit $?"
python3 - "$T/out" << 'PY' || fail "--watch kinds on every line"
import json, sys
ls = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
assert ls and all(isinstance(l.get("kinds"), list) and l["kinds"] for l in ls), ls
assert any(l["kinds"] == ["prompt"] for l in ls) and any("mcp:github" in l["kinds"] for l in ls), ls
PY
echo "events: ok"
