#!/bin/sh
# a broad skills.hide rule ("*" name) hides every skill name agentglass knows, from a log's first line: a prompt naming a
# skill that only the session's subagent loads, later (zorbent), an installed skill no session loaded (quillow), and a skill
# another session loaded (vexmark, once the ledger indexed it). `events --json --content` and `session --json`, on a
# cold cache and a warm one; prose words stay. sh scripts/skills-hide-known.test.sh
# check: builds 1
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR AGENTGLASS_REDACT AGENTGLASS_OTLP_DIR SSH_ORIGINAL_COMMAND # hermetic
export AGENTGLASS_AGENT=0
command -v python3 > /dev/null 2>&1 || { echo "skills-hide-known: skipped (needs python3)"; exit 0; }
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
fail=0
mkdir -p "$t/bin"
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/bin/agentglass"
else AGENTGLASS_OUT="$t/bin/agentglass" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
ag="$t/bin/agentglass"

# ── fixture: P names zorbent, quillow and vexmark in its prompts; only its subagent loads zorbent (after the prompt); O loads
# vexmark; quillow is installed (~/.claude/skills) and never loaded. No listing names any of them ──
h="$t/h"; app="$h/w/app"; d="$h/.claude/projects/-w-app"; P=6e1f0000-0000-4000-8000-0000000000aa; O=6e1f0000-0000-4000-8000-0000000000bb
mkdir -p "$app/.git" "$d/$P/subagents" "$h/.claude/skills/quillow" "$h/.agentglass"
printf -- '---\nname: quillow\ndescription: tidy things up\n---\nQUILLOWTEXT\n' > "$h/.claude/skills/quillow/SKILL.md"
python3 - "$d" "$P" "$O" "$app" << 'PY'
import json, sys, datetime
d, P, O, cwd = sys.argv[1:5]
t0 = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0) - datetime.timedelta(hours=2)
def ts(s): return (t0 + datetime.timedelta(seconds=s)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
def usage(g): return dict(input_tokens=10, cache_read_input_tokens=1000, cache_creation_input_tokens=g, output_tokens=20, cache_creation=dict(ephemeral_5m_input_tokens=g, ephemeral_1h_input_tokens=0))
def user(sid, s, c, n, **kw): return dict(parentUuid=None, isSidechain=kw.pop("side", False), promptId="p%d" % n, type="user", sessionId=sid, cwd=cwd, timestamp=ts(s), uuid="%s-u%d" % (sid[-4:], s), message=dict(role="user", content=c), **kw)
def asst(sid, s, content, **kw): return dict(type="assistant", isSidechain=kw.pop("side", False), sessionId=sid, cwd=cwd, timestamp=ts(s), uuid="%s-a%d" % (sid[-4:], s), requestId="%s_req_%d" % (sid[-4:], s), message=dict(id="%s_msg_%d" % (sid[-4:], s), model="claude-sonnet-4-5", role="assistant", content=content, usage=usage(1500)), **kw)
def load(sid, s, id, name, mark, **kw):
    return [asst(sid, s, [dict(type="text", text="ok"), dict(type="tool_use", id=id, name="Skill", input=dict(skill=name))], **kw),
            user(sid, s + 1, [dict(type="tool_result", tool_use_id=id, content="Launching skill: " + name)], 9, **kw),
            user(sid, s + 2, [dict(type="text", text="Base directory for this skill: /h/.claude/skills/%s\n\n%s %s" % (name, mark, "lorem ipsum " * 200))], 9, isMeta=True, sourceToolUseID=id, **kw)]
def write(p, L):
    with open(p, "w") as f:
        for o in L: f.write(json.dumps(o, separators=(",", ":")) + "\n")
write("%s/%s.jsonl" % (d, P), [
    user(P, 1, "plan the import: use zorbent for the csv, quillow to tidy up", 1),
    asst(P, 2, [dict(type="thinking", thinking="the user wants zorbent first, then quillow", signature="x"), dict(type="text", text="ok, zorbent it is")]),
    asst(P, 3, [dict(type="tool_use", id="toolu_t", name="Task", input=dict(description="import", prompt="run zorbent on data.csv", subagent_type="general-purpose"))]),
    user(P, 60, [dict(type="tool_result", tool_use_id="toolu_t", content="imported with zorbent")], 1),
    user(P, 61, "now vexmark, and quillow again", 2),
    asst(P, 62, [dict(type="text", text="done")])])
write("%s/%s/subagents/agent-a1.jsonl" % (d, P), [user(P, 4, "run zorbent on data.csv", 1, side=True, agentId="a1")] + load(P, 10, "toolu_z", "zorbent", "ZORBENTTEXT", side=True, agentId="a1") + [asst(P, 20, [dict(type="text", text="imported")], side=True, agentId="a1")])
write("%s/%s.jsonl" % (d, O), [user(O, 1, "mark the release", 1)] + load(O, 2, "toolu_v", "vexmark", "VEXMARKTEXT") + [asst(O, 8, [dict(type="text", text="marked")])])
PY
touch -t "$(python3 -c "import datetime; print((datetime.datetime.now()-datetime.timedelta(hours=1)).strftime('%Y%m%d%H%M'))")" "$d/$P.jsonl" "$d/$O.jsonl" "$d/$P/subagents/agent-a1.jsonl"
printf '{"skills":{"hide":[{"match":"*","mode":"name"}]}}\n' > "$t/hide.json"
printf '{}\n' > "$t/none.json"
run() { (cd "$app" && env -i HOME="$h" PATH="$PATH" TZ=UTC COLUMNS=120 AGENTGLASS_CACHE_DIR="$t/${CACHE:-cache}" AGENTGLASS_CONFIG="$t/${CFG:-hide}.json" AGENTGLASS_RULES=/nonexistent \
  AGENTGLASS_RUN_DIR="$t/run" AGENTGLASS_NOTIFY=0 AGENTGLASS_OFFLINE=1 AGENTGLASS_AGENT=0 AGENTGLASS_HERDR=off AGENTGLASS_PRICES="$t/prices.json" \
  AGENTGLASS_FLEET_DIR="$t/fleet" AGENTGLASS_HUB_DIR="$t/hub" AGENTGLASS_OTLP_DIR="$t/otlp" "$ag" "$@" 2> /dev/null || true); }
has() { case "$2" in *"$3"*) ;; *) echo "FAIL $1: no '$3' in: $(printf '%s' "$2" | head -c 300)"; fail=1 ;; esac; }
hasnt() { case "$2" in *"$3"*) echo "FAIL $1: '$3' present: $(printf '%s' "$2" | grep -o ".\{0,80\}$3.\{0,40\}" | head -2)"; fail=1 ;; esac; }

# without rules: the names show (the fixture is right)
r=$(CFG=none CACHE=c0 run events "claude:$P" --json --content)
for w in zorbent quillow vexmark; do has "no rules: events" "$r" "$w"; done
# cold cache: the subagent's load and the installed skill hide the prompt's names from its first line
r=$(CACHE=c1 run events "claude:$P" --json --content)
for w in zorbent quillow; do hasnt "cold: events" "$r" "$w"; done
has "cold: prose stays" "$r" "plan the import"; has "cold: prose stays" "$r" "to tidy up"
r=$(CACHE=c1 run session "claude:$P" --json); for w in zorbent quillow; do hasnt "cold: session" "$r" "$w"; done
# warm: the ledger indexed O, its load hides vexmark in P too
CACHE=c1 run skills --period all > /dev/null
r=$(CACHE=c1 run events "claude:$P" --json --content)
for w in zorbent quillow vexmark ZORBENTTEXT; do hasnt "warm: events" "$r" "$w"; done
has "warm: prose stays" "$r" "now"
r=$(CACHE=c1 run session "claude:$P" --json); for w in zorbent quillow vexmark; do hasnt "warm: session" "$r" "$w"; done

[ "$fail" = 0 ] && echo "skills-hide-known: ok"
exit "$fail"
