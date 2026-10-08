#!/bin/sh
# agentglass-mcp end to end on a fake HOME (spec mcp-server, Testing): conformance under 2025-11-25 and 2024-11-05,
# identity from the process tree (a wrong session id in the env), project scope, the content canary, --redact,
# cancel, shutdown, and that the server's children never show in `wait --now`: sh scripts/mcp.test.sh
# check: builds 1
set -e
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d)
pids=""; trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; for p in $pids; do kill -TERM -- "-$p" 2>/dev/null || kill "$p" 2>/dev/null || true; done; [ -n "${MCP_TEST_KEEP:-}" ] && echo "kept $t" || rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
command -v python3 > /dev/null 2>&1 || { echo "mcp: skipped (needs python3)"; exit 0; }
mkdir -p "$t/bin"
if [ -n "${AGENTGLASS_BIN:-}" ]; then # the suite's shared binary; agentglass-mcp is small: built here from the same src/build-info.ts
  cp "$AGENTGLASS_BIN" "$t/bin/agentglass"
  ( cd "$here" && . ./scripts/toolchain.sh && { [ -f src/build-info.ts ] || sh scripts/build-info.sh; } && scriptc build ${SCRIPTC_FLAGS:-} src/mcp/main.ts -o "$t/bin/agentglass-mcp" ) > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }
else AGENTGLASS_OUT="$t/bin/agentglass" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
[ -x "$t/bin/agentglass-mcp" ] || { echo "FAIL build: no agentglass-mcp beside agentglass"; cat "$t/build.log"; exit 1; }
cp "$here/scripts/mcp-client.py" "$t/client.py" # (a name without "mcp": the fake agent's tree must not look like an MCP server)
G1="$here/testdata/mcp/tools-2025-11-25.json"; G0="$here/testdata/mcp/tools-2024-11-05.json"

# ── fixture: Claude sessions A, B in p1 and C in p2; A carries the canary in a tool result, a later prompt and assistant text ──
h="$t/h"; p1="$h/w/p1"; p2="$h/w/p2"; mkdir -p "$p1/.git" "$p2/.git" "$h/.claude/sessions"
A=abcdef01-0000-4000-8000-000000000001; B=abcdef02-0000-4000-8000-000000000002; C=abcdef03-0000-4000-8000-000000000003
min=$(date -u +%Y-%m-%dT%H:%M); ts() { printf '%s:%02d.000Z' "$min" "$1"; }
u() { printf '{"type":"user","sessionId":"%s","cwd":"%s","timestamp":"%s","message":{"role":"user","content":%s}}\n' "$1" "$2" "$(ts "$3")" "$4"; }
as() { printf '{"type":"assistant","sessionId":"%s","cwd":"%s","timestamp":"%s","message":{"id":"%s","role":"assistant","model":"claude-sonnet-4-5","content":%s,"usage":{"input_tokens":1000,"output_tokens":100}}}\n' "$1" "$2" "$(ts "$3")" "$4" "$5"; }
d1="$h/.claude/projects/-w-p1"; d2="$h/.claude/projects/-w-p2"; mkdir -p "$d1" "$d2"
{ u "$A" "$p1" 1 '"fix the build"'
  as "$A" "$p1" 2 m1 '[{"type":"tool_use","id":"toolu_a1","name":"Bash","input":{"command":"npm test"}}]'
  u "$A" "$p1" 3 '[{"type":"tool_result","tool_use_id":"toolu_a1","content":"Exit code 1\nCANARY-7f3a npm ERR! missing script","is_error":true}]'
  u "$A" "$p1" 4 '"second prompt CANARY-7f3a"'
  as "$A" "$p1" 5 m2 '[{"type":"text","text":"CANARY-7f3a the answer"}]'; } > "$d1/$A.jsonl"
{ u "$B" "$p1" 6 '"hello b"'; as "$B" "$p1" 7 m3 '[{"type":"text","text":"hi"}]'; } > "$d1/$B.jsonl"
{ u "$C" "$p2" 8 '"hello c"'; as "$C" "$p2" 9 m4 '[{"type":"text","text":"hi"}]'; } > "$d2/$C.jsonl"

# a clean environment: no markers of the agent that runs this suite; agentglass and agentglass-mcp first on PATH
run() { env -i HOME="$h" PATH="$t/bin:$PATH" AGENTGLASS_CACHE_DIR="$t/cache" AGENTGLASS_CONFIG="$t/config.json" AGENTGLASS_RULES=/nonexistent \
  AGENTGLASS_NOTIFY=0 AGENTGLASS_OFFLINE=1 AGENTGLASS_HERDR=off "$@"; }
# srv <cwd> <script> <out> [server options…]: one server under the test client
srv() { c=$1; s=$2; o=$3; shift 3; run python3 "$t/client.py" --cwd "$c" --timeout 60 -- "$t/bin/agentglass-mcp" "$@" < "$s" > "$o" 2>&1 || true; }
# a fake Claude Code process: /bin/sh started as "claude" (its argv names the harness), registered in
# ~/.claude/sessions/<pid>.json as session $1, with CLAUDE_CODE_SESSION_ID naming a *different* session (C, in p2) —
# a nested host passes on an outer agent's id. It runs the client (and $3: extra shell commands, e.g. a tool shell)
ln -s /bin/sh "$t/bin/claude"
# asrv <session> <cwd> <script> <out> [server options…]
asrv() {
  sid=$1; c=$2; s=$3; o=$4; shift 4
  run CLAUDE_CODE_SESSION_ID="$C" "$t/bin/claude" -c 'printf "{\"pid\":%s,\"sessionId\":\"%s\",\"cwd\":\"%s\",\"status\":\"busy\"}" $$ "$1" "$2" > "$HOME/.claude/sessions/$$.json"
    echo $$ > "$5/agent.pid"; sid=$1; c=$2; s=$3; o=$4; t=$5; shift 5
    python3 "$t/client.py" --cwd "$c" --timeout 60 -- agentglass-mcp "$@" < "$s" > "$o" 2>&1; rc=$?
    rm -f "$HOME/.claude/sessions/$$.json"; exit $rc' claude "$sid" "$c" "$s" "$o" "$t" "$@" || true
}
init() { # init <version>: initialize, initialized, ping, tools/list
  printf '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"%s","capabilities":{},"clientInfo":{"name":"mcp.test","version":"1"}}}\n{"wait":0}\n' "$1"
  printf '{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"wait":1}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n{"wait":2}\n'
}
call() { printf '{"jsonrpc":"2.0","id":%s,"method":"tools/call","params":{"name":"%s","arguments":%s}}\n{"wait":%s}\n' "$1" "$2" "$3" "$1"; }
# py <out> <expr>: evaluate expr with r(id) = the response with that id (None if missing), sc(id) = its
# structuredContent, tx(id) = its text block parsed, lines = every JSON line; prints the value (eval: the expressions
# are this test's own, the data is only read)
py() { python3 - "$@" << 'PY'
import json, sys
ls = []
for l in open(sys.argv[1], encoding="utf-8"):
    p = l.rstrip("\n").split("\t", 1)
    if len(p) == 2 and p[0].isdigit():
        try: ls.append((int(p[0]), json.loads(p[1])))
        except ValueError: ls.append((int(p[0]), p[1]))
lines = [m for _, m in ls]
def r(i): return next((m for m in lines if isinstance(m, dict) and m.get("id") == i and "method" not in m), None)
def res(i): x = r(i); return x.get("result") if x else None
def sc(i): x = res(i); return x.get("structuredContent") if x else None
def tx(i):
    x = res(i)
    try: return json.loads(x["content"][0]["text"])
    except Exception: return None
def at(word): return next((t for t, m in ls if m == word), -1)
def golden(p): return json.load(open(p))
# a structuredContent against its outputSchema: type, properties, items (the subset the schemas use)
def valid(v, s):
    t = s.get("type")
    if t is not None:
        ts = t if isinstance(t, list) else [t]
        okt = {"object": isinstance(v, dict), "array": isinstance(v, list), "string": isinstance(v, str), "boolean": isinstance(v, bool),
               "number": isinstance(v, (int, float)) and not isinstance(v, bool), "integer": isinstance(v, int) and not isinstance(v, bool), "null": v is None}
        if not any(okt.get(x, False) for x in ts): return False
    if isinstance(v, dict): return all(valid(v[k], ps) for k, ps in s.get("properties", {}).items() if k in v)
    if isinstance(v, list) and "items" in s: return all(valid(x, s["items"]) for x in v)
    return True
print(eval(sys.argv[2]))
PY
}

# ── 1. conformance (2025-11-25 and 2024-11-05), under the fake agent of session A in p1 ──
TOOLS="session sessions errors cost triage compare related contention waits fleet prices"
conf() { # conf <version> <script>
  init "$1" > "$2"; i=10
  for n in $TOOLS; do
    a='{}'; [ "$n" != compare ] || a="{\"sessions\":[\"$A\",\"$B\"]}"
    call $i "$n" "$a" >> "$2"; i=$((i + 1))
  done
  call 30 nope '{}' >> "$2"; call 31 sessions '{"limit":0}' >> "$2"
  printf '{"jsonrpc":"2.0","id":32,"method":"resources/list"}\n{"wait":32}\n' >> "$2"
}
conf 2025-11-25 "$t/c1.jsonl"; asrv "$A" "$p1" "$t/c1.jsonl" "$t/c1.out"; apid=$(cat "$t/agent.pid")
conf 2024-11-05 "$t/c0.jsonl"; asrv "$A" "$p1" "$t/c0.jsonl" "$t/c0.out"
for v in 1 0; do
  o="$t/c$v.out"; ver=$([ $v = 1 ] && echo 2025-11-25 || echo 2024-11-05); G=$([ $v = 1 ] && echo "$G1" || echo "$G0")
  eq "$ver: initialize" "$(py "$o" "res(0)['protocolVersion'] + ' ' + res(0)['serverInfo']['name'] + ' ' + str(res(0)['_meta']['agentglass/contract'])")" "$ver agentglass 1"
  eq "$ver: ping" "$(py "$o" "res(1)")" "{}"
  eq "$ver: tools/list = golden" "$(py "$o" "res(2) == golden('$G')")" True
  i=10
  for n in $TOOLS; do eq "$ver: $n {}" "$(py "$o" "(res($i) or {}).get('isError', False)")" False; i=$((i + 1)); done
  eq "$ver: unknown tool" "$(py "$o" "r(30)['error']['code']")" -32602
  eq "$ver: bad input" "$(py "$o" "res(31)['isError']")" True
  eq "$ver: unknown method" "$(py "$o" "r(32)['error']['code']")" -32601
  eq "$ver: stderr silent" "$(grep -cv "$(printf '^[0-9]*\t')" "$o" || true)" 0
done
eq "fleet: configured false" "$(py "$t/c1.out" "sc(19)")" "{'hosts': [], 'configured': False}"
eq "structuredContent = text" "$(py "$t/c1.out" "all(sc(i) == tx(i) for i in range(10, 21))")" True
eq "structuredContent valid against outputSchema" "$(py "$t/c1.out" "[n for i, n in zip(range(10, 21), '$TOOLS'.split()) if not valid(sc(i), next(x['outputSchema'] for x in res(2)['tools'] if x['name'] == n))]")" "[]"
eq "2024-11-05: no structuredContent" "$(grep -c structuredContent "$t/c0.out" || true)" 0
eq "contention go" "$(py "$t/c1.out" "sc(17)['go'], sc(17)['advice']")" "(True, '0 heavy commands running: go')"

# ── 2. identity: the process tree, not the env (CLAUDE_CODE_SESSION_ID names C); the registry moves A → B (/clear) ──
eq "identity: session {} = the fake agent's" "$(py "$t/c1.out" "sc(10)['id']")" "$A"
eq "identity: via the process tree" "$(py "$t/c1.out" "sc(10)['via'].startswith('ancestor:pid ')")" True
eq "identity: the agent's pid" "$(py "$t/c1.out" "sc(10)['via']")" "ancestor:pid $apid"
# open question 1: the same process moves to another session (/clear, /resume): its registry entry is rewritten
cat > "$t/moved.sh" << EOF
#!/bin/sh
# a client script step: rewrite the fake agent's registry entry to session B, then ask again
sed "s/$A/$B/" "$h/.claude/sessions/\$(cat "$t/agent.pid").json" > "$t/reg" && mv "$t/reg" "$h/.claude/sessions/\$(cat "$t/agent.pid").json"
EOF
{ init 2025-11-25; call 10 session '{"fields":["id","via"]}'; } > "$t/m1.jsonl"
# the move happens between two servers' calls of one agent process: one asrv runs both through a wrapper client script
cat > "$t/two.sh" << 'EOF'
python3 "$T/client.py" --cwd "$P" --timeout 60 -- agentglass-mcp < "$T/m1.jsonl" > "$T/m1.out" 2>&1
sh "$T/moved.sh"
python3 "$T/client.py" --cwd "$P" --timeout 60 -- agentglass-mcp < "$T/m1.jsonl" > "$T/m2.out" 2>&1
EOF
run CLAUDE_CODE_SESSION_ID="$C" T="$t" P="$p1" "$t/bin/claude" -c 'printf "{\"pid\":%s,\"sessionId\":\"%s\",\"cwd\":\"%s\",\"status\":\"busy\"}" $$ "$1" "$P" > "$HOME/.claude/sessions/$$.json"; echo $$ > "$T/agent.pid"; sh "$T/two.sh"; rm -f "$HOME/.claude/sessions/$$.json"; :' claude "$A" || true
eq "registry moved: before" "$(py "$t/m1.out" "sc(10)['id']")" "$A"
eq "registry moved: after" "$(py "$t/m2.out" "sc(10)['id']")" "$B"
# no process link (a sandbox without ps, or no harness process): the env id, through the one retry
{ init 2025-11-25; call 10 session '{"fields":["id","via"]}'; } > "$t/e.jsonl"
run CLAUDE_CODE_SESSION_ID="$A" python3 "$t/client.py" --cwd "$p1" --timeout 60 -- agentglass-mcp < "$t/e.jsonl" > "$t/e.out" 2>&1 || true
eq "env retry" "$(py "$t/e.out" "sc(10)['id'], sc(10)['via']")" "('$A', 'env:CLAUDE_CODE_SESSION_ID')"
srv "$p1" "$t/e.jsonl" "$t/e2.out"
eq "no agent: no current session" "$(py "$t/e2.out" "res(10)['isError'], sc(10)['error']['code']")" "(True, 'no_current_session')"

# ── 3. scope ──
{ init 2025-11-25; call 10 sessions '{"since":"30d"}'; } > "$t/s.jsonl"
srv "$p1" "$t/s.jsonl" "$t/s1.out"
eq "scope: project" "$(py "$t/s1.out" "sorted(x['id'] for x in sc(10)['rows']), sc(10)['scope']")" "(['$A', '$B'], 'project')"
srv "$p1" "$t/s.jsonl" "$t/s2.out" --all-projects
eq "scope: --all-projects" "$(py "$t/s2.out" "sorted(x['id'] for x in sc(10)['rows']), sc(10)['scope']")" "(['$A', '$B', '$C'], 'all')"
eq "scope: instructions" "$(py "$t/s2.out" "'(all projects)' in res(0)['instructions']")" True
asrv "$A" "$h" "$t/s.jsonl" "$t/s3.out"
eq "scope: server in \$HOME takes the session's cwd" "$(py "$t/s3.out" "sorted(x['id'] for x in sc(10)['rows'])")" "['$A', '$B']"
srv "$h" "$t/s.jsonl" "$t/s4.out"
eq "scope: \$HOME without a session" "$(py "$t/s4.out" "sc(10)['error']['code']")" no_project
# pages: the cursor of the first page brings the second
{ init 2025-11-25; call 10 sessions '{"since":"30d","limit":1}'; } > "$t/pg1.jsonl"; srv "$p1" "$t/pg1.jsonl" "$t/pg1.out"
cur=$(py "$t/pg1.out" "sc(10)['next']")
{ init 2025-11-25; call 11 sessions "{\"since\":\"30d\",\"limit\":1,\"cursor\":\"$cur\"}"; } > "$t/pg2.jsonl"; srv "$p1" "$t/pg2.jsonl" "$t/pg2.out"
eq "pages" "$(py "$t/pg1.out" "sc(10)['rows'][0]['id']") $(py "$t/pg2.out" "sc(11)['rows'][0]['id'], sc(11)['next']")" "$B ('$A', None)"

# ── 4. content canary: nothing above carried it; --content brings tool results back ──
{ init 2025-11-25; call 10 errors "{\"ref\":\"$A\"}"; call 11 session "{\"ref\":\"$A\"}"; call 12 related "{\"ref\":\"$A\",\"minutes\":60}"; call 13 errors '{"since":"30d"}'; } > "$t/k.jsonl"
srv "$p1" "$t/k.jsonl" "$t/k0.out"
eq "canary: the calls answered" "$(py "$t/k0.out" "[(res(i) or {}).get('isError', False) for i in (10, 11, 12, 13)]")" "[False, False, False, False]"
eq "canary: errors listed" "$(py "$t/k0.out" "len(sc(10)['rows'])")" 1
eq "canary: absent without --content" "$(cat "$t"/c1.out "$t"/c0.out "$t"/k0.out "$t"/s*.out | grep -c CANARY || true)" 0
srv "$p1" "$t/k.jsonl" "$t/k1.out" --content
eq "canary: errors --content" "$(py "$t/k1.out" "'CANARY-7f3a' in sc(10)['rows'][0]['text']")" True

# ── 5. --redact: fake titles, instructions without the project ──
srv "$p1" "$t/s.jsonl" "$t/r.out" --redact
eq "redact: titles faked" "$(py "$t/r.out" "sorted(x['title'] for x in sc(10)['rows']) != ['fix the build', 'hello b']")" True
eq "redact: rows" "$(py "$t/r.out" "len(sc(10)['rows'])")" 2
eq "redact: instructions" "$(py "$t/r.out" "'p1' in res(0)['instructions']")" False

# ── 6. cancel and 7. shutdown: a stub CLI that answers --version and else sleeps ──
cat > "$t/slow.sh" << EOF
#!/bin/sh
case "\$*" in *--version*) echo '{"version":"x","contract":1}'; exit 0;; esac
echo \$\$ > "$t/slow.pid"; exec sleep 30
EOF
chmod +x "$t/slow.sh"
{ init 2025-11-25; printf '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"fleet","arguments":{}}}\n{"sleep":500}\n'
  printf '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":5,"reason":"user"}}\n{"expect_none":5,"ms":1500}\n'
  call 6 nope '{}'; } > "$t/x.jsonl"
rm -f "$t/slow.pid"; run AGENTGLASS_MCP_BIN="$t/slow.sh" python3 "$t/client.py" --cwd "$p1" --timeout 30 -- agentglass-mcp < "$t/x.jsonl" > "$t/x.out" 2>&1 || true
sp=$(cat "$t/slow.pid" 2>/dev/null || echo 0)
eq "cancel: the child ran" "$([ "$sp" -gt 0 ] && echo yes)" yes
eq "cancel: no response" "$(grep -c 'FAIL' "$t/x.out" || true) $(py "$t/x.out" "r(5)")" "0 None"
eq "cancel: child gone" "$(kill -0 "$sp" 2>/dev/null && echo alive || echo gone)" gone
eq "cancel: server still answers" "$(py "$t/x.out" "r(6)['error']['code']")" -32602
{ init 2025-11-25; printf '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"fleet","arguments":{}}}\n{"sleep":400}\n{"close":true}\n'; } > "$t/y.jsonl"
rm -f "$t/slow.pid"; run AGENTGLASS_MCP_BIN="$t/slow.sh" python3 "$t/client.py" --cwd "$p1" --timeout 30 -- agentglass-mcp < "$t/y.jsonl" > "$t/y.out" 2>&1 || true
sp=$(cat "$t/slow.pid" 2>/dev/null || echo 0)
eq "shutdown: exit 0 within 1.5 s" "$(py "$t/y.out" "[m for m in lines if isinstance(m, str) and m.startswith('EXIT')] == ['EXIT 0'] and next(t for t, m in ls if m == 'EXIT 0') - at('CLOSED') <= 1500")" True
eq "shutdown: child gone" "$([ "$sp" -gt 0 ] && ! kill -0 "$sp" 2>/dev/null && echo gone)" gone
# framing: a request split across writes, a UTF-8 character split, garbage, an oversize line
{ printf '{"raw":"{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"met"}\n{"sleep":100}\n{"raw":"hod\\":\\"ping\\"}\\n"}\n{"wait":1}\n'
  printf '{"raw":"not json\\n"}\n{"raw":"[1,2]\\n"}\n'
  python3 -c 'import json; print(json.dumps({"raw": "{\"x\":\"" + "a" * (4 * 1024 * 1024 + 10) + "\"}\n"}))'
  printf '{"jsonrpc":"2.0","id":2,"method":"ping"}\n{"wait":2}\n'; } > "$t/f.jsonl"
srv "$p1" "$t/f.jsonl" "$t/f.out"
eq "framing: split request" "$(py "$t/f.out" "res(1)")" "{}"
eq "framing: garbage and oversize answered, server alive" "$(py "$t/f.out" "[m['error']['code'] for m in lines if isinstance(m, dict) and m.get('id') is None and 'error' in m], res(2)")" "([-32700, -32600, -32600], {})"

# ── 8. wait --now: the fake agent's own tool shell is listed; agentglass-mcp and its child are not ──
{ init 2025-11-25; printf '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"fleet","arguments":{}}}\n{"sleep":6000}\n'; } > "$t/w.jsonl"
rm -f "$t/slow.pid"
run AGENTGLASS_MCP_BIN="$t/slow.sh" T="$t" P="$p1" "$t/bin/claude" -c 'printf "{\"pid\":%s,\"sessionId\":\"%s\",\"cwd\":\"%s\",\"status\":\"busy\"}" $$ "$1" "$P" > "$HOME/.claude/sessions/$$.json"
  /bin/sh -c "sleep 7; :" & python3 "$T/client.py" --cwd "$P" --timeout 30 -- agentglass-mcp < "$T/w.jsonl" > "$T/w.out" 2>&1; rm -f "$HOME/.claude/sessions/$$.json"; wait' claude "$A" &
pids="$!"
n=0; while [ ! -s "$t/slow.pid" ] && [ $n -lt 100 ]; do sleep 0.1; n=$((n + 1)); done
run AGENTGLASS_AGENT=0 "$t/bin/agentglass" wait --now --json > "$t/now.json" 2>&1 || true
fams=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(" ".join(sorted(r["family"] for r in d["now"]["running"])))' "$t/now.json" 2>/dev/null || cat "$t/now.json")
eq "wait --now: the agent's shell" "$(case " $fams " in *" sleep "*) echo listed;; *) echo "missing in: $fams";; esac)" listed
eq "wait --now: no agentglass or stub" "$(printf '%s\n' $fams | grep -cE '^(agentglass|slow|python)' || true)" 0
wait $pids 2>/dev/null || true; pids=""

[ $fail = 0 ] && echo "mcp: all tests passed"
exit $fail
