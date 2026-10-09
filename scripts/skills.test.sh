#!/bin/sh
# agentglass skills (skill-usage §6.17, §6.13, Privacy) against a fake HOME with the synthetic Claude, Codex and pi logs of
# testdata/skills: the table (120 and 80 columns), --json, a session timeline, show (text on demand), --check, --redact,
# skills.hide modes, --json session entries, --watch skill lines, usage errors: sh scripts/skills.test.sh
# UPDATE_GOLDEN=1 rewrites the goldens.
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR AGENTGLASS_REDACT # hermetic: the fake HOME decides
export AGENTGLASS_AGENT=0
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
has() { case "$2" in *"$3"*) ;; *) echo "FAIL $1: no '$3' in: $(printf '%s' "$2" | head -c 300)"; fail=1 ;; esac; }
hasnt() { case "$2" in *"$3"*) echo "FAIL $1: '$3' present"; fail=1 ;; esac; }
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/ag"; else AGENTGLASS_OUT="$t/ag" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
h="$t/h"; d="$here/testdata/skills"
C=5c1f0000-0000-4000-8000-000000000001; X=c0de0000-0000-4000-8000-000000000001; P=p1000000-0000-4000-8000-000000000001
mkdir -p "$h/.claude/projects/-w-app" "$h/.codex/sessions/2026/10/01" "$h/.pi/agent/sessions/--w-app--" "$h/w/app"
cp "$d/claude.jsonl" "$h/.claude/projects/-w-app/$C.jsonl"
cp "$d/codex.jsonl" "$h/.codex/sessions/2026/10/01/rollout-2026-10-01T10-00-00-$X.jsonl"
cp "$d/pi.jsonl" "$h/.pi/agent/sessions/--w-app--/2026-10-01T10-00-00-000Z_$P.jsonl"
run() { env -i HOME="$h" PATH="$PATH" TZ=UTC COLUMNS="${COLS:-120}" AGENTGLASS_CACHE_DIR="$t/cache" AGENTGLASS_CONFIG="${CFG:-$t/config.json}" AGENTGLASS_RULES=/nonexistent \
  AGENTGLASS_RUN_DIR="$t/run" AGENTGLASS_NOTIFY=0 AGENTGLASS_OFFLINE=1 AGENTGLASS_AGENT=0 AGENTGLASS_HERDR=off AGENTGLASS_PRICES="$t/prices.json" \
  AGENTGLASS_FLEET_DIR="$t/fleet" AGENTGLASS_HUB_DIR="$t/hub" AGENTGLASS_OTLP_DIR="$t/otlp" ${RED:+AGENTGLASS_REDACT=1} "$t/ag" "$@"; }
golden() { # golden <name> <text>
  if [ -n "${UPDATE_GOLDEN:-}" ]; then printf '%s\n' "$2" > "$d/$1"; return; fi
  printf '%s\n' "$2" > "$t/got"; diff -u "$d/$1" "$t/got" > "$t/diff" || { echo "FAIL golden $1:"; head -40 "$t/diff"; fail=1; }
}
golden skills.golden "$(run skills --period all)"
golden skills-80.golden "$(COLS=80 run skills --period all)"
golden skills-json.golden "$(run skills --period all --json | python3 -m json.tool --sort-keys)"
golden skills-session.golden "$(run skills --session "claude:$C")"
run skills --check --period all > "$t/check" && rc=0 || rc=$?
eq "--check exit" "$rc" 0; has "--check line" "$(cat "$t/check")" "ok skill invariants: 3 sessions"

# text on demand: shown by default (also a load assembled from two reads and one over two lines), hidden by choice
has "show default" "$(run skills show "claude:$C#sk2")" "LOREMSKILLTEXT"
has "show two-part read" "$(run skills show "codex:$X#sk1")" "MORELOREMTEXT"
has "show by name" "$(run skills show delta --period all)" "LOREMSKILLTEXT"
has "--session --json text" "$(run skills --session "pi:$P" --json)" "\"text\":\"LOREMSKILLTEXT"
eq "show missing load" "$(run skills show "claude:$C#sk99" > /dev/null 2>&1 && echo 0 || echo $?)" 3
r=$(RED=1 run skills show "claude:$C#sk2"); has "show --redact" "$r" "text hidden (--redact)"; hasnt "show --redact text" "$r" "LOREMSKILLTEXT"; hasnt "show --redact name" "$r" "beta"

# --redact: no user skill name, no text; hashes stay
r=$(RED=1 run skills --period all --json)
for n in alpha beta delta gamma; do hasnt "--redact $n" "$r" "\"$n\""; done
hasnt "--redact text" "$r" "LOREMSKILLTEXT"; has "--redact hash kept" "$r" "$(run skills --period all --json | python3 -c 'import json,sys; print([x for x in json.load(sys.stdin)["rows"] if x["name"]=="beta"][0]["hashes"][0])')"
has "--redact listing kept" "$r" "(listing)"

# skills.hide: name (faked everywhere), omit (gone, tokens in one (hidden) row), content (text hidden)
printf '{"skills":{"hide":[{"match":"bet?","mode":"name"},{"match":"delta","mode":"omit"},"alpha"]}}\n' > "$t/hide.json"
r=$(CFG="$t/hide.json" run skills --period all --json)
hasnt "hide name" "$r" "\"beta\""; hasnt "hide omit" "$r" "\"delta\""; has "hide omit row" "$r" "\"(hidden)\""; has "hide content keeps name" "$r" "\"alpha\""
eq "hide keeps totals" "$(printf '%s' "$r" | python3 -c 'import json,sys; print(sum(x["load"]+x["carry"] for x in json.load(sys.stdin)["rows"]))')" \
  "$(run skills --period all --json | python3 -c 'import json,sys; print(sum(x["load"]+x["carry"] for x in json.load(sys.stdin)["rows"]))')"
has "hide content text" "$(CFG="$t/hide.json" run skills show "claude:$C#sk1")" "text hidden by skills.hide"
hasnt "hide omit timeline" "$(CFG="$t/hide.json" run skills --session "claude:$C")" "delta"
printf '{"skills":{"hide":[{"match":"x","mode":"bogus"}]}}\n' > "$t/bad.json"
has "bad rule warns" "$(CFG="$t/bad.json" run skills --period all 2>&1 > /dev/null)" "mode must be content, name or omit"

# --json sessions: skills[] entries keep {name,source,n} and gain their loads, tokens and $; skillLoads on request
r=$(run --json --filter "harness is claude" | python3 -c 'import json,sys; s=json.load(sys.stdin)[0]["skills"]; print(" ".join(sorted(s[0].keys())), [(x["name"],x["source"],x["n"],x["loads"]) for x in s])')
eq "--json skills entry" "$r" "carryUsd costUsd dir hash loads n name scope size source tailUsd tier tokens [('beta', 'model', 2, 2), ('alpha', 'command', 1, 1), ('delta', 'model', 1, 1), ('gamma', 'command', 1, 1)]"
r=$(run --json --filter "harness is codex" | python3 -c 'import json,sys; x=json.load(sys.stdin)[0]["skills"][0]; print(x["name"], x["source"], x["n"], x["loads"], x["tier"], x["dir"], x["tokens"]["load"] > 0)')
eq "--json codex SKILL.md read" "$r" "alpha model 1 1 ≈ /h/.codex/skills/alpha True"
hasnt "--json no text" "$(run --json --fields id,skillLoads)" "LOREMSKILLTEXT"
printf '{"skills":{"hide":[{"match":"alpha","mode":"name"}]}}\n' > "$t/hidea.json"
r=$(CFG="$t/hidea.json" run --json --fields id,title,skills); hasnt "--json hide name in title and skills" "$r" "alpha"; has "--json title kept" "$r" "/skill:"
has "--json skillLoads --content" "$(run --json --fields id,skillLoads --content)" "LOREMSKILLTEXT"
# a glob rule hides a name in titles and activity before any load of it was seen (the --watch stream's first lines)
printf '{"skills":{"hide":[{"match":"alph*","mode":"omit"}]}}\n' > "$t/hideg.json"
(CFG="$t/hideg.json" run --watch --from-start --for 3s > "$t/watchgo" 2> /dev/null) || true
hasnt "--watch glob omit: no name in any line" "$(cat "$t/watchgo")" "alpha"; has "--watch glob omit: lines" "$(cat "$t/watchgo")" "\"title\""
hasnt "--json glob omit: no name in title or activity" "$(CFG="$t/hideg.json" run --json --fields id,title,activity)" "alpha"
printf '{"skills":{"hide":[{"match":"*","mode":"omit"}]}}\n' > "$t/hideall.json"
has "a * omit rule: titles keep their words" "$(CFG="$t/hideall.json" run --json --fields id,title)" "start the fixture"

# --watch: skill and skill_end lines in stream order
run --watch --from-start --for 3s > "$t/watch" 2> /dev/null || true
has "--watch skill" "$(cat "$t/watch")" "\"kind\":\"skill\""
has "--watch skill_end" "$(cat "$t/watch")" "\"kind\":\"skill_end\""
hasnt "--watch skill lines carry no text" "$(grep '"kind":"skill' "$t/watch")" "LOREMSKILLTEXT"
# the event-kind filter takes skill lines: event.kind is skill streams only them, each with its kinds
run --watch --from-start --for 3s --filter "event.kind is skill" > "$t/watchk" 2> /dev/null || true
eq "--watch kind filter: only skill kinds" "$(grep -vc '"kinds":\["skill:' "$t/watchk")" 0 # skill lines, and Skill calls (kind skill:load)
has "--watch kind filter: loads" "$(cat "$t/watchk")" '"kinds":["skill:load"]'; has "--watch kind filter: unloads" "$(cat "$t/watchk")" '"kinds":["skill:unload"]'
# --watch with skill keys: only the load lines of that skill (skill.cost is refused: known only after the requests)
run --watch --from-start --for 3s --filter "skill is alpha" > "$t/watchs" 2> /dev/null || true
eq "--watch skill is: only alpha's lines" "$(grep -vc '"name":"alpha"' "$t/watchs")" 0
has "--watch skill is: its load" "$(cat "$t/watchs")" '"kind":"skill"'
r=$(run --watch --from-start --for 1s --filter "skill.cost > 1" 2>&1 || true); has "--watch refuses skill.cost" "$r" "known only after"
# --watch under skills.hide: the calls that load a hidden skill (Skill, Read/read of a SKILL.md, a Codex sed) show the fake
# name or nothing (omit), and their results no text
(CFG="$t/hide.json" run --watch --from-start --for 3s > "$t/watchh" 2> /dev/null) || true
r=$(cat "$t/watchh"); hasnt "--watch hide name" "$r" "beta"; hasnt "--watch hide omit" "$r" "delta"; hasnt "--watch hide text" "$r" "LOREMSKILLTEXT"
hasnt "--watch hide text (2nd part)" "$r" "MORELOREMTEXT"; has "--watch hide result" "$r" "(text hidden by skills.hide)"; has "--watch keeps content-mode name" "$r" "alpha"

# a glob rule hides a matching name in every --watch line from the first one, before (or without) any load of the skill
G=91ab0000-0000-4000-8000-000000000001; mkdir -p "$h/.claude/projects/-w-glob"
{ printf '{"type":"user","sessionId":"%s","cwd":"/w/glob","timestamp":"2026-10-01T11:00:00.000Z","message":{"role":"user","content":"run acme:internal-deploy on staging"}}\n' "$G"
  printf '{"type":"assistant","sessionId":"%s","cwd":"/w/glob","timestamp":"2026-10-01T11:00:01.000Z","message":{"id":"mg1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"acme:internal-deploy is not loaded"}],"usage":{"input_tokens":10,"output_tokens":5}}}\n' "$G"; } > "$h/.claude/projects/-w-glob/$G.jsonl"
printf '{"skills":{"hide":[{"match":"*:internal-*","mode":"name"},{"match":"acme:sec*","mode":"omit"}]}}\n' > "$t/glob.json"
(CFG="$t/glob.json" run --watch --from-start --for 3s > "$t/watchg" 2> /dev/null) || true
r=$(grep "$G" "$t/watchg" || true); has "--watch glob: the session's lines" "$r" "$G"; hasnt "--watch glob rule hides from the first line" "$r" "internal-deploy"
rm -rf "$h/.claude/projects/-w-glob"

has "advise runs" "$(run skills advise --period all)" "no advice in the history"
# usage
eq "bad period" "$(run skills --period 3w > /dev/null 2>&1 && echo 0 || echo $?)" 2
eq "bad subcommand" "$(run skills frob > /dev/null 2>&1 && echo 0 || echo $?)" 2
has "--help" "$(run skills --help)" "agentglass skills advise"
has "help lists skills" "$(run --help)" "agentglass skills"
[ $fail -eq 0 ] && echo "skills: all checks passed" || exit 1
