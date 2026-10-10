#!/bin/sh
# agentglass team CLI (fleet-teams Task 8a): two machines (HOMEs A and B, full isolation set each) and one shared folder.
# create → invite; join in agent mode without --yes shows the consent screen and exits 2; --dry-run shows exactly what
# would leave; join → A admits → B publishes → A's report and sessions show bob's api session, nothing of acme/secret.
#   sh scripts/team.test.sh (uses AGENTGLASS_BIN)
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR AGENTGLASS_REDACT AGENTGLASS_FLEET_DIR AGENTGLASS_RUN_DIR AGENTGLASS_TEAM_DIR
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); t=$(cd "$t" && pwd -P)
trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
has() { case "$2" in *"$3"*) ;; *) echo "FAIL $1: no '$3' in: $(printf %s "$2" | head -c 600)"; fail=1;; esac; }
hasnt() { case "$2" in *"$3"*) echo "FAIL $1: '$3' in: $(printf %s "$2" | head -c 600)"; fail=1;; esac; }
mkdir -p "$t/bin"
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/bin/agentglass"; else AGENTGLASS_OUT="$t/bin/agentglass" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
# a machine: its HOME, a host id, a repo per name with a session in it
home() {
  mkdir -p "$t/$1/.agentglass" "$t/$1/.claude/projects/-acme"
  printf '%s\n' "$2" > "$t/$1/.agentglass/host-id"
  printf '{"apiKeyHelper":"/bin/true"}\n' > "$t/$1/.claude/settings.json"
}
repo() { # machine repo session tokens
  d="$t/$1/acme/$2"; mkdir -p "$d/.git"; printf '[remote "origin"]\n\turl = https://github.com/acme/%s.git\n' "$2" > "$d/.git/config"
  f="$t/$1/.claude/projects/-acme/$3.jsonl"
  printf '{"type":"user","sessionId":"%s","cwd":"%s","timestamp":"%s","message":{"role":"user","content":"work on %s"}}\n' "$3" "$d" "$now" "$2" > "$f"
  printf '{"type":"assistant","sessionId":"%s","cwd":"%s","timestamp":"%s","message":{"id":"m-%s","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":%s,"output_tokens":10}}}\n' "$3" "$d" "$now" "$3" "$4" >> "$f"
}
home A 1111111111111111; home B 2222222222222222
repo A api a-api 1000; repo B api b-api 100000; repo B secret b-secret 900000
F="$t/Sync/agentglass-acme"; mkdir -p "$F"; chmod 700 "$F"
run() { # machine agent? args… — the full isolation set of that machine
  w=$1; ag=$2; shift 2
  env HOME="$t/$w" AGENTGLASS_AGENT="$ag" AGENTGLASS_CACHE_DIR="$t/$w/cache" AGENTGLASS_CONFIG="$t/$w/config.json" AGENTGLASS_RULES="$t/$w/rules.json" \
    AGENTGLASS_RUN_DIR="$t/$w/run" AGENTGLASS_PALETTE_FILE="$t/$w/palette.json" AGENTGLASS_THEME_FILE="$t/$w/theme" AGENTGLASS_PRICES="$t/$w/prices.json" \
    AGENTGLASS_OTLP_DIR="$t/$w/otlp" AGENTGLASS_FLEET_DIR="$t/$w/fleet" AGENTGLASS_HUB_DIR="$t/$w/hub" AGENTGLASS_TEAM_DIR="$t/$w/team" AGENTGLASS_NOTIFY=0 \
    "$t/bin/agentglass" "$@"
}
# jq1 <expr>: a fixed Python expression of this script over the JSON on stdin (the expressions are the test's own, never data)
jq1() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

# 1. A creates the team with room backend → an invite
c=$(run A 0 team create acme --dir "$F" --room backend=github.com/acme/api --name anna --json)
eq "create ok" "$(printf %s "$c" | jq1 'd["ok"]')" "True"
code=$(printf %s "$c" | jq1 'd["invite"]["code"]')
has "invite code" "$code" "agt1-"
[ -f "$F/agentglass-team.json" ] || { echo "FAIL no discovery file"; fail=1; }
# 2. B in agent mode without --yes: the consent screen as JSON, exit 2
set +e; s=$(run B 1 team join "$code" --dir "$F" --name bob --json); rc=$?; set -e
eq "agent mode without --yes: exit 2" "$rc" "2"
has "screen: room backend" "$s" "\"backend\""
has "screen: you have acme/api" "$s" "github.com/acme/api"
hasnt "screen: not acme/secret" "$s" "acme/secret"
has "screen: a person must consent" "$s" "consent"
# 3. --dry-run: exactly what would leave, nothing joined
d=$(run B 1 team join "$code" --dir "$F" --name bob --share backend --dry-run --json)
has "dry run: the api session" "$d" "claude:b-api"
hasnt "dry run: nothing of secret" "$d" "secret"
hasnt "dry run: no path" "$d" "$t"
hasnt "dry run: no title at level numbers" "$d" "\"title\""
[ ! -d "$t/B/team" ] || [ -z "$(ls "$t/B/team" 2>/dev/null)" ] || { echo "FAIL dry run wrote a team"; fail=1; }
[ -z "$(ls "$F/join" 2>/dev/null)" ] || { echo "FAIL dry run wrote a request"; fail=1; }
# 4. join, admit, publish, report
j=$(run B 0 team join "$code" --dir "$F" --name bob --share backend --yes --wait 0 --json)
eq "join requested" "$(printf %s "$j" | jq1 'd["ok"]')" "True"
run A 0 team sync --json > "$t/sa.json"
has "A admits bob" "$(cat "$t/sa.json")" "admitted"
run B 0 team sync --json > "$t/sb.json"
has "B publishes" "$(cat "$t/sb.json")" "rooms/"
r=$(run A 0 team report --by member --json)
has "report: bob" "$r" "\"bob\""
eq "report: bob's api cost" "$(printf %s "$r" | jq1 '[x for x in d["rows"] if x["key"]=="bob"][0]["costUsd"] > 0')" "True"
ss=$(run A 0 team sessions --member bob --json)
eq "sessions: bob's api session only" "$(printf %s "$ss" | jq1 'len(d["rows"])')" "1"
hasnt "sessions: no cwd" "$ss" "\"cwd\""
hasnt "sessions: no title" "$ss" "\"title\""
st=$(run A 0 team --json)
has "status: the team" "$st" "\"acme\""
has "status: bob a member" "$st" "\"bob\""
[ $fail = 0 ] && echo "team.test.sh: ok"
exit $fail
