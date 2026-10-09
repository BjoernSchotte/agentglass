#!/bin/sh
# hidden skills stay hidden on every surface (skill-usage Privacy, Testing; plan Task P2): a fake HOME with a Claude log
# that loads pub (no rule), acme-x (name), secret (omit) and notes (content), each with its own text marker
# (testdata/skills-hide/gen.py). Every CLI form — skills, skills show, skills --session --json, --json (+ skillLoads
# --content), --watch, events, session, errors, --json --related, compare, triage, export (OTLP), the hub's stored
# files, fleet pull / snapshot / fleet skills, MCP tools — under the rules: acme-x appears nowhere and its fake does,
# secret appears nowhere and its tokens sit in the (hidden) row, no hidden skill's text anywhere, pub's text locally and
# outward only with --content. Without rules nothing is hidden locally; --redact hides every user skill name.
# The TUI surfaces (transcript, view skill, Stats panel, preview, Repos, triage, compare, related, call graph, replay,
# Wait, rules messages) are walked by src/features/skills/hide.check.ts. sh scripts/skills-hide.test.sh
# check: builds 1
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR AGENTGLASS_REDACT AGENTGLASS_OTLP_DIR SSH_ORIGINAL_COMMAND # hermetic
export AGENTGLASS_AGENT=0
command -v python3 > /dev/null 2>&1 || { echo "skills-hide: skipped (needs python3)"; exit 0; }
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); srv=""
trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; { [ -z "$srv" ] || kill $srv; wait; } 2>/dev/null || true; rm -rf "$t"' EXIT
fail=0
mkdir -p "$t/bin"
if [ -n "${AGENTGLASS_BIN:-}" ]; then # the suite's shared binary; agentglass-mcp (small) built here, as scripts/mcp.test.sh does
  cp "$AGENTGLASS_BIN" "$t/bin/agentglass"
  ( cd "$here" && . ./scripts/toolchain.sh && { [ -f src/build-info.ts ] || sh scripts/build-info.sh; } && scriptc build ${SCRIPTC_FLAGS:-} src/mcp/main.ts -o "$t/bin/agentglass-mcp" ) > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }
else AGENTGLASS_OUT="$t/bin/agentglass" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
ag="$t/bin/agentglass"

# ── fixture: session A loads all four skills, B (for compare) pub and acme-x; logs idle for an hour (turns closed) ──
h="$t/h"; app="$h/w/app"; d="$h/.claude/projects/-w-app"; mkdir -p "$app/.git" "$d" "$h/.agentglass"
A=5e1f0000-0000-4000-8000-0000000000aa; B=5e1f0000-0000-4000-8000-0000000000bb
python3 "$here/testdata/skills-hide/gen.py" "$d/$A.jsonl" "$A" "$app"
python3 "$here/testdata/skills-hide/gen.py" "$d/$B.jsonl" "$B" "$app" pub,acme-x
touch -t "$(python3 -c "import datetime; print((datetime.datetime.now()-datetime.timedelta(hours=1)).strftime('%Y%m%d%H%M'))")" "$d/$A.jsonl" "$d/$B.jsonl"
echo 00112233445566ff > "$h/.agentglass/host-id"
printf '{"skills":{"hide":[{"match":"acme-*","mode":"name"},{"match":"secret","mode":"omit"},"notes"]}}\n' > "$t/hide.json"
printf '{}\n' > "$t/none.json"
runx() { (cd "$app" && env -i HOME="$h" PATH="$PATH" TZ=UTC COLUMNS=120 AGENTGLASS_CACHE_DIR="$t/cache" AGENTGLASS_CONFIG="$t/${CFG:-hide}.json" AGENTGLASS_RULES=/nonexistent \
  AGENTGLASS_RUN_DIR="$t/run" AGENTGLASS_NOTIFY=0 AGENTGLASS_OFFLINE=1 AGENTGLASS_AGENT=0 AGENTGLASS_HERDR=off AGENTGLASS_PRICES="$t/prices.json" \
  AGENTGLASS_FLEET_DIR="$t/fleet" AGENTGLASS_HUB_DIR="$t/hub" AGENTGLASS_OTLP_DIR="$t/otlp" ${RED:+AGENTGLASS_REDACT=1} ${SOC:+SSH_ORIGINAL_COMMAND="$SOC"} "$@"); }
run() { runx "$ag" "$@" 2>&1 || true; } # exit codes are not this test's subject
runq() { runx "$ag" "$@" 2> /dev/null || true; } # stdout only (JSON to parse)

has() { case "$2" in *"$3"*) ;; *) echo "FAIL $1: no '$3' in: $(printf '%s' "$2" | head -c 300)"; fail=1 ;; esac; }
hasnt() { case "$2" in *"$3"*) echo "FAIL $1: '$3' present: $(printf '%s' "$2" | grep -o ".\{0,80\}$3.\{0,40\}" | head -2)"; fail=1 ;; esac; }
# hidden <surface> <output>: nothing of acme-x (name), secret (omit) or notes' text; never pub's either without --content
hidden() {
  [ -n "$2" ] || { echo "FAIL $1: no output"; fail=1; return; }
  for w in acme-x secret ACMESKILLTEXT SECRETSKILLTEXT NOTESSKILLTEXT; do hasnt "$1" "$2" "$w"; done
}
fake=$(runq skills --period all --json | python3 -c 'import json,sys; r=[x["name"] for x in json.load(sys.stdin)["rows"] if x["name"] not in ("pub","notes","(listing)","(hidden)")]; print(r[0] if r else "?")')
[ ${#fake} -eq 6 ] || { echo "FAIL acme-x's fake: '$fake'"; fail=1; }
(CFG=none runq skills --period all --json > "$t/all.json")

# ── local CLI surfaces under the rules ──
r=$(run skills --period all); hidden "skills" "$r"; has "skills: fake" "$r" "$fake"; has "skills: (hidden) row" "$r" "(hidden)"; has "skills: content mode keeps the name" "$r" "notes"
r=$(COLUMNS=80 run skills --period all); hidden "skills 80 cols" "$r"
r=$(run skills --period all --json); hidden "skills --json" "$r"
r=$(runq skills --period all --json)
printf '%s' "$r" > "$t/hide-rows.json"
eq_tok=$(python3 - "$t/all.json" "$t/hide-rows.json" << 'PY'
import json, sys
a = {x["name"]: x for x in json.load(open(sys.argv[1]))["rows"]}; b = {x["name"]: x for x in json.load(open(sys.argv[2]))["rows"]}
h = b.get("(hidden)"); s = a.get("secret")
print("ok" if h and s and h["load"] + h["carry"] == s["load"] + s["carry"] and abs(sum(x["usd"] for x in a.values()) - sum(x["usd"] for x in b.values())) < 1e-9 else "got %r want %r" % (h, s))
PY
); [ "$eq_tok" = ok ] || { echo "FAIL (hidden) row carries secret's tokens, totals unchanged: $eq_tok"; fail=1; }
r=$(run skills show acme-x --period all); hidden "skills show <name rule>" "$r"; has "skills show: why" "$r" "text hidden by skills.hide"
r=$(run skills show "$fake" --period all); hidden "skills show <fake>" "$r"
r=$(run skills show notes --period all); hidden "skills show <content rule>" "$r"; has "skills show notes: why" "$r" "text hidden by skills.hide"
r=$(run skills show secret --period all); hidden "skills show <omitted>" "$(printf '%s' "$r" | sed 's/"secret"//')"; has "skills show <omitted>: no load" "$r" "no load"
r=$(run skills show pub --period all); has "skills show pub: text locally" "$r" "PUBSKILLTEXT"
r=$(run skills --session "claude:$A"); hidden "skills --session" "$r"
r=$(run skills --session "claude:$A" --json); hidden "skills --session --json" "$r"; has "skills --session --json: pub's text" "$r" "PUBSKILLTEXT"
r=$(run skills advise --period all); hidden "skills advise" "$r"
r=$(run skills advise --period all --json); hidden "skills advise --json" "$r"
r=$(run --json); hidden "--json" "$r"; has "--json: fake in skills[]" "$r" "\"$fake\""
r=$(run --json --fields id,title,activity,skills,skillLoads --content); hidden "--json skillLoads --content" "$r"; has "--json --content: pub's text" "$r" "PUBSKILLTEXT"
r=$(run --watch --from-start --for 2s); hidden "--watch" "$r"; has "--watch: lines" "$r" "\"kind\":\"skill\""
r=$(run events "claude:$A" --content --json); hidden "events --content --json" "$r"; has "events: fake call" "$r" "$fake"
r=$(run events "claude:$A" --content); hidden "events --content" "$r"
r=$(run events "claude:$A" --json); hidden "events --json" "$r"
r=$(run events "claude:$A" --filter 'event.kind is skill' --json); hidden "events skill filter" "$r"
r=$(run session "claude:$A"); hidden "session" "$r"
r=$(run sessions --since 30d); hidden "sessions" "$r"
r=$(run errors --since 30d); hidden "errors" "$r"; has "errors: the Bash failure" "$r" "git status"
r=$(run --json --related "claude:$A" --minutes 240); hidden "--json --related" "$r"; has "--json --related: rows" "$r" "\"events\""
r=$(run compare "claude:$A" "claude:$B" --json); hidden "compare" "$r"
r=$(run triage --entity session --select "skill is $fake" --json); hidden "triage" "$r"
r=$(run cost --json); hidden "cost" "$r"

# ── outward: OTLP export (dry run), the hub's stored files, fleet, MCP ──
r=$(run export --dry-run --since all); hidden "export" "$r"; hasnt "export: no text without --content" "$r" "PUBSKILLTEXT"; has "export: fake" "$r" "$fake"
r=$(run export --dry-run --since all --content); hidden "export --content" "$r"; has "export --content: pub's text" "$r" "PUBSKILLTEXT"
r=$(CFG=none run export --dry-run --since all); hasnt "export without rules: no text" "$r" "PUBSKILLTEXT"; has "export without rules: names" "$r" "acme-x"
mkdir -p "$t/hubhome"
HOME="$t/hubhome" AGENTGLASS_HUB_DIR="$t/hubdir" "$ag" receive token add host1 > "$t/tok"
grep '^  Authorization: Bearer ' "$t/tok" | sed 's/^  //' > "$t/headers"; chmod 600 "$t/headers"
HOME="$t/hubhome" AGENTGLASS_HUB_DIR="$t/hubdir" "$ag" receive --listen 127.0.0.1:0 2> "$t/srv.err" & srv=$!
i=0; while [ ! -s "$t/hubdir/port" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done
printf '{"skills":{"hide":[{"match":"acme-*","mode":"name"},{"match":"secret","mode":"omit"},"notes"]},"otlp":{"headersFile":"%s"}}\n' "$t/headers" > "$t/hubsend.json"
(CFG=hubsend run export --otlp "http://127.0.0.1:$(cat "$t/hubdir/port")" --since all --content > "$t/exp.out") || { echo "FAIL export to the hub: $(cat "$t/exp.out") $(cat "$t/srv.err")"; fail=1; }
kill $srv 2>/dev/null; wait $srv 2>/dev/null || true; srv=""
r=$(cat "$t"/hubdir/*/*.jsonl 2>/dev/null || true); hidden "hub files" "$r"; has "hub files: fake" "$r" "$fake"
r=$(SOC='agentglass fleet pull --days 7' run fleet serve); hidden "fleet pull" "$r"; has "fleet pull: fake" "$r" "$fake"
r=$(run fleet snapshot --full --days 7); hidden "fleet snapshot" "$r"; has "fleet snapshot: fake" "$r" "$fake"
r=$(run fleet skills --period 7d --json); hidden "fleet skills" "$r"
cp "$here/scripts/mcp-client.py" "$t/client.py"
mcp() { # mcp <cfg> [--content]: every tool that can show a skill, once
  { printf '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"skills-hide","version":"1"}}}\n{"wait":0}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n'
    i=2; for c in "events|{\"ref\":\"claude:$A\"}" "skills|{\"period\":\"all\"}" "skills|{\"ref\":\"claude:$A\"}" "skills|{\"advise\":true,\"period\":\"all\"}" "session|{\"ref\":\"claude:$A\"}" \
      "related|{\"ref\":\"claude:$A\",\"minutes\":60}" "sessions|{}" "errors|{}" "compare|{\"a\":\"claude:$A\",\"b\":\"claude:$B\"}"; do
      i=$((i+1)); printf '{"jsonrpc":"2.0","id":%s,"method":"tools/call","params":{"name":"%s","arguments":%s}}\n{"wait":%s}\n' "$i" "${c%%|*}" "${c#*|}" "$i"; done; } > "$t/mcp.jsonl"
  (CFG=$1 runx python3 "$t/client.py" --cwd "$app" --timeout 60 -- "$t/bin/agentglass-mcp" $2 < "$t/mcp.jsonl" 2>&1)
}
r=$(mcp hide); [ -z "${SKH_DEBUG:-}" ] || printf "%s\n" "$r" > "$SKH_DEBUG"; hidden "mcp" "$r"; has "mcp: fake" "$r" "$fake"; hasnt "mcp: no text without --content" "$r" "PUBSKILLTEXT"
r=$(mcp hide --content); hidden "mcp --content" "$r"
r=$(mcp none); hasnt "mcp without rules: no text without --content" "$r" "SKILLTEXT"; has "mcp without rules: names" "$r" "acme-x"

# ── memos from a run without rules (the ledger keeps a log's head and tail outcome: title, last event) do not show
# hidden skills in a later run with rules: session C ends on secret's text, its title names acme-x ──
C=5e1f0000-0000-4000-8000-0000000000cc; python3 "$here/testdata/skills-hide/gen.py" "$d/$C.jsonl" "$C" "$app" secret,stop
touch -t "$(python3 -c "import datetime; print((datetime.datetime.now()-datetime.timedelta(hours=1)).strftime('%Y%m%d%H%M'))")" "$d/$C.jsonl"
(CFG=none run --json --fields id,title,activity > "$t/memo-none"); has "memo: no rules, the real title" "$(cat "$t/memo-none")" "acme-x"
r=$(run --json --fields id,title,activity); hidden "memo: --json title, activity" "$r"
r=$(run sessions --since 30d); hidden "memo: sessions" "$r"
rm -f "$d/$C.jsonl"

# ── without rules nothing is hidden locally ──
r=$(CFG=none run skills --period all); for n in pub acme-x secret notes; do has "no rules: skills $n" "$r" "$n"; done; hasnt "no rules: no (hidden) row" "$r" "(hidden)"
has "no rules: skills show text" "$(CFG=none run skills show acme-x --period all)" "ACMESKILLTEXT"
r=$(CFG=none run events "claude:$A" --content --json); has "no rules: events name" "$r" "acme-x"; has "no rules: events read text" "$r" "SECRETSKILLTEXT"

# ── --redact: no user skill name, no text ──
r=$(RED=1 CFG=none run skills --period all --json); for n in pub acme-x secret notes; do hasnt "--redact skills $n" "$r" "\"name\":\"$n\""; done; hasnt "--redact skills text" "$r" "SKILLTEXT"
r=$(RED=1 CFG=none run events "claude:$A" --content --json); for n in acme-x secret SKILLTEXT; do hasnt "--redact events" "$r" "$n"; done
r=$(RED=1 CFG=none run export --dry-run --since all --content); for n in acme-x secret SKILLTEXT; do hasnt "--redact export" "$r" "$n"; done

[ $fail -eq 0 ] && echo "skills-hide: all checks passed" || exit 1
