#!/bin/sh
# agent mode end to end: no TUI under a PTY, no prompts, query commands on a fake HOME (Claude + Codex in p1, Gemini in p2): sh scripts/agent-mode.test.sh
set -e
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
# a stable version: a local build never counts as a downgrade
# a private source copy (its build-info.ts) keeps src/ untouched while other builds run
mkdir "$t/src" && cp -R "$here/src/." "$t/src/"
AGENTGLASS_SRC="$t/src" AGENTGLASS_VERSION=2026.10.2 AGENTGLASS_CHANNEL=stable AGENTGLASS_COMMIT=3333333333333333333333333333333333333333 AGENTGLASS_OUT="$t/ag" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }
h="$t/h"; p1="$h/w/p1"; p2="$h/w/p2"; mkdir -p "$p1/.git" "$p2/.git"
CL=abcdef01-0000-4000-8000-000000000001; CX=abcdef02-0000-4000-8000-000000000002; GM=99999999-0000-4000-8000-000000000003
# portable (GNU + BSD): this minute, $1 = a tie-breaking second; file ages via touch -t
min=$(date -u +%Y-%m-%dT%H:%M); ts() { printf '%s:%02d.000Z' "$min" "$((60 - $1 % 60 - 1))"; }
# Claude in p1: 2 turns, a failing Bash call
cp="$h/.claude/projects/-w-p1"; mkdir -p "$cp"
cu() { printf '{"type":"user","sessionId":"%s","cwd":"%s","timestamp":"%s","message":{"role":"user","content":%s}}\n' "$CL" "$p1" "$(ts "$1")" "$2"; }
ca() { printf '{"type":"assistant","sessionId":"%s","cwd":"%s","timestamp":"%s","message":{"id":"%s","role":"assistant","model":"claude-sonnet-4-5","content":%s,"usage":{"input_tokens":1000,"output_tokens":100}}}\n' "$CL" "$p1" "$(ts "$1")" "$2" "$3"; }
{ cu 300 '"run the tests"'; ca 299 m1 '[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test"}}]'
  cu 298 '[{"type":"tool_result","tool_use_id":"t1","content":"Exit code 1\nnpm ERR! missing script: test","is_error":true}]'
  cu 290 '"thanks"'; ca 289 m2 '[{"type":"text","text":"ok"}]'; } > "$cp/$CL.jsonl"
touch -t "$(date +%Y%m%d)0000" "$cp/$CL.jsonl" # older than the Codex session
# Codex in p1, newer
xd="$h/.codex/sessions/$(date +%Y/%m/%d)"; mkdir -p "$xd"
{ printf '{"timestamp":"%s","type":"session_meta","payload":{"id":"%s","cwd":"%s","timestamp":"%s","originator":"codex_exec"}}\n' "$(ts 200)" "$CX" "$p1" "$(ts 200)"
  printf '{"timestamp":"%s","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"refactor"}]}}\n' "$(ts 199)"; } > "$xd/rollout-$(date +%Y-%m-%dT%H-%M-%S)-$CX.jsonl"
# Gemini in p2: a failed shell call
gd="$h/.gemini/tmp/p2"; mkdir -p "$gd/chats"; printf '%s\n' "$p2" > "$gd/.project_root"
{ printf '{"sessionId":"%s","projectHash":"ab","startTime":"%s","lastUpdated":"%s","kind":"main"}\n' "$GM" "$(ts 100)" "$(ts 100)"
  printf '{"id":"u1","timestamp":"%s","type":"user","content":[{"text":"build it"}]}\n' "$(ts 99)"
  printf '{"id":"g1","timestamp":"%s","type":"gemini","content":"","model":"gemini-2.5-flash","tokens":{"input":10,"output":5,"cached":0},"toolCalls":[{"id":"k1","name":"run_shell_command","args":{"command":"make"},"status":"error","timestamp":"%s","result":[{"functionResponse":{"response":{"error":"make: *** No targets"}}}]}]}\n' "$(ts 98)" "$(ts 97)"; } > "$gd/chats/session-2026-10-01T10-00-99999999.jsonl"

# a clean environment: no markers of the agent that runs this suite
run() { env -i HOME="$h" PATH="$PATH" AGENTGLASS_CACHE_DIR="$t/cache" AGENTGLASS_NOTIFY=0 AGENTGLASS_OFFLINE=1 "$@"; }
agent() { run CLAUDECODE=1 CLAUDE_CODE_SESSION_ID="$CL" "$t/ag" "$@"; }

# bare agentglass under a PTY inside an agent: compact help at once, never the TUI (perl alarm: a hang fails, not blocks)
# a PTY for "sh -c $1" from python's forkpty (Linux and macOS alike: BSD script fails on a non-terminal stdin), else script
if command -v python3 > /dev/null 2>&1; then
  pty() { python3 -c 'import os, sys
pid, fd = os.forkpty()
if pid == 0: os.execvp("sh", ["sh", "-c", sys.argv[1]])
out = b""
while True:
    try: b = os.read(fd, 4096)
    except OSError: break
    if not b: break
    out += b
os.waitpid(pid, 0); sys.stdout.buffer.write(out)' "$1"; }
elif script --version > /dev/null 2>&1; then pty() { script -qec "$1" /dev/null; } # util-linux
else pty() { script -q /dev/null sh -c "$1"; }; fi # BSD
s0=$(date +%s)
set +e; out=$(pty "env -i HOME='$h' PATH='$PATH' CLAUDECODE=1 AGENTGLASS_CACHE_DIR='$t/cache' perl -e 'alarm 3; exec @ARGV' '$t/ag'" < /dev/null | tr -d '\r'); set -e; s1=$(date +%s)
[ $((s1 - s0)) -le 2 ] || { echo "FAIL pty: took $((s1 - s0)) s"; fail=1; }
eq "pty: valid JSON" "$(printf '%s' "$out" | jq -r '.name')" agentglass
[ "$(printf '%s' "$out" | wc -c)" -le 1536 ] || { echo "FAIL pty: compact help over 1.5 KB"; fail=1; }
case "$out" in *'"options"'*|*"$(printf '\033')"*) echo "FAIL pty: option tables or escapes in the compact help"; fail=1;; esac
eq "pipe: compact help" "$(agent < /dev/null | jq -r '.agentMode.harness')" claude
eq "compact help: fleet discoverable" "$(printf '%s' "$out" | jq -r '[.commands[].cmd | select(. == "fleet")] | length')" 1
# with a real session id (36 characters) too, and the commands an agent runs listed (wait, open, --version)
ch=$(agent < /dev/null)
[ "$(printf '%s' "$ch" | wc -c)" -le 1536 ] || { echo "FAIL compact help with a session id over 1.5 KB ($(printf '%s' "$ch" | wc -c))"; fail=1; }
eq "compact help: wait, open, --version" "$(printf '%s' "$ch" | jq -r '[.commands[].cmd | select(. == "wait" or . == "open" or . == "--version")] | length')" 3

# update never asks inside an agent: a downgrade without --yes exits 2 with one JSON error line
printf '[{"tag_name":"v2000.1.1","prerelease":false,"draft":false,"assets":[{"name":"agentglass-x.tar.gz"},{"name":"SHA256SUMS"},{"name":"build-metadata.json"}]}]' > "$t/rels.json"
plat=$("$t/ag" --version --json | jq -r '.platform'); sed "s/agentglass-x/agentglass-$plat/" "$t/rels.json" > "$t/rels2.json"
set +e; run CLAUDECODE=1 AGENTGLASS_RELEASES_API="file://$t/rels2.json" AGENTGLASS_DOWNLOAD_BASE="file://$t/none" perl -e 'alarm 2; exec @ARGV' "$t/ag" update --tag v2000.1.1 --force < /dev/null > "$t/o" 2> "$t/e"; rc=$?; set -e
eq "update: exit" "$rc" 2
eq "update: stdout empty" "$(cat "$t/o")" ""
eq "update: one JSON line" "$(wc -l < "$t/e" | tr -d ' ')|$(jq -r '.error.message' < "$t/e" | grep -c downgrade)" "1|1"

# an unknown command inside an agent is a usage error, not the compact help with exit 0
set +e; agent sesions > "$t/o" 2> "$t/e"; rc=$?; set -e
eq "unknown command" "$rc|$(jq -r '.error.code' < "$t/e")|$(cat "$t/o")" "2|usage|"
# --watch inside an agent needs a bound
set +e; agent --watch > "$t/o" 2> "$t/e"; rc=$?; set -e
eq "watch unbounded" "$rc|$(jq -r '.error.code' < "$t/e")" "2|usage"

cd "$p1"
eq "session current" "$(agent session current --fields id,costUsd,errors | jq -c '[.id, (.errors | length), (.costUsd > 0)]')" "[\"$CL\",1,true]"
eq "session current: one line" "$(agent session current --fields id | wc -l | tr -d ' ')" 1
eq "session last" "$(agent session last --fields id | jq -r '.id')" "$CX"
set +e; agent session abcdef > /dev/null 2> "$t/e"; rc=$?; set -e
eq "ambiguous prefix" "$rc|$(jq -r '.error.code' < "$t/e")" "4|ambiguous"
set +e; agent session zzzzzz > /dev/null 2>&1; rc=$?; set -e
eq "unknown id" "$rc" 3
set +e; agent session "$GM" > /dev/null 2> "$t/e"; rc=$?; set -e
eq "other project's session" "$rc|$(jq -r '.error.code' < "$t/e")" "3|out_of_scope"
eq "other project's session, widened" "$(agent session "$GM" --all-projects --fields harness | jq -r '.harness')" gemini
# the session list and the event stream are scoped too: no other project's titles, paths or events
eq "--json: project scope" "$(agent --json | jq -c 'map(.harness) | sort')" '["claude","codex"]'
eq "--json --all-projects" "$(agent --json --all-projects | jq -r 'length')" 3
eq "--watch: project scope" "$(agent --watch --from-start --for 2s | jq -r '.harness' | sort -u | tr '\n' ' ')" "claude codex "
eq "--watch --all-projects" "$(agent --watch --from-start --for 2s --all-projects | jq -r '.harness' | sort -u | tr '\n' ' ')" "claude codex gemini "
# a prefix that only matches other projects' sessions is out of scope, not ambiguous (no candidate ids leak)
set +e; (cd "$p2" && agent session abcdef > /dev/null 2> "$t/e"); rc=$?; set -e
eq "prefix of other projects" "$rc|$(jq -r '.error.code' < "$t/e")|$(grep -c "$CX" < "$t/e")" "3|out_of_scope|0"
e=$(agent errors)
eq "errors: project scope" "$(printf "%s" "$e" | jq -c '[.scope, .source, (.rows | map(.harness))]')" '["project","calls",["claude"]]'
eq "errors: text by call id" "$(printf "%s" "$e" | jq -r '.rows[0].text' | head -1)" "Exit code 1"
eq "errors --all-projects" "$(agent errors --all-projects | jq -c '[.scope, (.rows | map(.harness))]')" '["all",["gemini","claude"]]'
# --filter on the queries: call clauses on errors, session clauses on sessions and cost rows; a bad one is a JSON error
eq "errors --filter" "$(agent errors --filter 'tool is Bash' | jq -r '.rows | length')|$(agent errors --filter 'tool is Edit' | jq -r '.rows | length')" "1|0"
eq "errors: arg from the rows" "$(agent errors | jq -r '.rows[0].arg')" "npm test"
eq "sessions --filter" "$(agent sessions --filter 'harness is codex' | jq -r 'map(.id) | join(",")')" "$CX"
eq "cost --filter (rows by day)" "$(agent cost --filter 'harness is codex' | jq -r '.rows[-1].sessions')" 0
set +e; agent errors --filter 'tol is Bash' > "$t/o" 2> "$t/e"; rc=$?; set -e
eq "bad filter: JSON error" "$rc|$(jq -r '.error.code' < "$t/e")|$(cat "$t/o")" "2|filter|"
# triage inside an agent: JSON by default, the current repo only (no p2 / gemini rows)
tj=$(agent triage --preset errors --entity session)
eq "triage: JSON, project scope" "$(printf '%s' "$tj" | jq -r 'has("rows")')|$(printf '%s' "$tj" | grep -c 'gemini\|"p2"')" "true|0"
# compare / triage / open / rules / export / update inside an agent: JSON out, JSON errors, refs, the project scope
cj=$(agent compare current "$CX" || true)
eq "compare: JSON, current ref" "$(printf '%s' "$cj" | jq -r '[.a.n, .b.n] | join(",")')" "1,1"
set +e; agent compare current "$GM" > "$t/o" 2> "$t/e"; rc=$?; set -e
eq "compare: other project" "$rc|$(jq -r '.error.code' < "$t/e")|$(cat "$t/o")" "3|out_of_scope|"
eq "compare --a/--b: project scope" "$(agent compare --a 'harness is claude' --b 'harness is gemini' | jq -r '[.a.n, .b.n] | join(",")')" "1,0"
eq "compare --all-projects" "$(agent compare --a 'harness is claude' --b 'harness is gemini' --all-projects | jq -r '.b.n')" 1
set +e; agent compare abc "$CX" > "$t/o" 2> "$t/e"; rc=$?; set -e
eq "compare: JSON usage error" "$rc|$(jq -r '.error.code' < "$t/e")" "2|usage"
set +e; agent triage --preset nope > "$t/o" 2> "$t/e"; rc=$?; set -e
eq "triage: JSON usage error" "$rc|$(jq -r '.error.code' < "$t/e")" "2|usage"
eq "open current --print" "$(agent open current --print | jq -r '.id')" "$CL"
eq "open last --print" "$(agent open last --print | jq -r '.id')" "$CX"
eq "rules check: JSON" "$(agent rules check | jq -r 'has("rules")')" true
set +e; agent export --otlp > "$t/o" 2> "$t/e"; rc=$?; set -e
eq "export: JSON usage error" "$rc|$(jq -r '.error.code' < "$t/e")" "2|usage"
set +e; agent update --bogus > "$t/o" 2> "$t/e"; rc=$?; set -e
eq "update: usage exit 2" "$rc|$(jq -r '.error.code' < "$t/e")" "2|usage"
c=$(agent cost --by model --format csv)
eq "cost csv header" "$(printf "%s\n" "$c" | head -1)" "key,in,out,cacheRead,cacheWrite,costUsd,unpricedTokens,sessions,priceSource,estimated"
eq "cost csv rows" "$(printf "%s\n" "$c" | tail -n +2 | cut -d, -f1 | tr '\n' ' ')" "claude-sonnet-4-5 total "
eq "agent summary = cost --json" "$(agent cost | jq -c 'keys')" '["budget","month","today","week"]'

# outside agent mode: a pipe gets JSON, --format table aligned text, the scope is everything
eq "sessions: pipe → json" "$(run "$t/ag" sessions | jq -r 'length')" 3
tb=$(run "$t/ag" sessions --format table --fields harness,project)
eq "sessions: table" "$(printf "%s\n" "$tb" | head -1)" "harness  project"
eq "sessions: table rows" "$(printf "%s\n" "$tb" | tail -n +2 | sort | tr '\n' '|')" "claude   p1|codex    p1|gemini   p2|"
set +e; run "$t/ag" sessions --fields nope > /dev/null 2> "$t/e"; rc=$?; set -e
eq "unknown field" "$rc|$(head -1 "$t/e" | cut -c1-30)" "2|agentglass: unknown field nope"
[ $fail = 0 ] && echo "agent mode: all checks passed"; exit $fail
