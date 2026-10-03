#!/usr/bin/env python3
# writes testdata/otlp/fixtures/<harness>/ — hand-written lines in the real shapes (invented ids, paths, text)
# regenerate: python3 testdata/otlp/genfix.py .
import json, os, sys
R = sys.argv[1] + "/testdata/otlp/fixtures"
def w(path, lines):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        for l in lines: f.write((l if isinstance(l, str) else json.dumps(l, separators=(",", ":"))) + "\n")
def wj(path, o):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f: json.dump(o, f, separators=(",", ":"))
def ts(m, s=0, ms=0): return "2026-09-01T10:%02d:%02d.%03dZ" % (m, s, ms)
CWD = "/home/u/proj"

# ── claude ──
H = R + "/claude"
SID = "11111111-1111-4111-8111-111111111111"
P = H + "/.claude/projects/-home-u-proj"
def cl(type_, t, msg, **kw):
    o = {"parentUuid": None, "isSidechain": False, "userType": "external", "cwd": CWD, "sessionId": SID, "version": "2.1.90", "gitBranch": "main", "type": type_, "message": msg, "uuid": "u-" + t, "timestamp": t}
    o.update(kw); return o
def asst(t, mid, model, content, usage, **kw):
    return cl("assistant", t, {"id": mid, "type": "message", "role": "assistant", "model": model, "content": content, "stop_reason": None, "usage": usage}, **kw)
def res(t, cid, text, err=False):
    return cl("user", t, {"role": "user", "content": [{"tool_use_id": cid, "type": "tool_result", "content": text, "is_error": err}]}, toolUseResult={"stdout": text})
UA = {"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 20, "cache_creation": {"ephemeral_5m_input_tokens": 20, "ephemeral_1h_input_tokens": 0}}
w(P + "/" + SID + ".jsonl", [
    cl("user", ts(0), {"role": "user", "content": "fix the build"}, promptId="p1"),
    asst(ts(0, 2), "msg_a", "claude-sonnet-4-5", [{"type": "text", "text": "Let me look."}], UA),
    asst(ts(0, 2, 500), "msg_a", "claude-sonnet-4-5", [{"type": "tool_use", "id": "toolu_bash", "name": "Bash", "input": {"command": "git status", "description": "status"}}], UA),
    asst(ts(0, 3), "msg_a", "claude-sonnet-4-5", [{"type": "tool_use", "id": "toolu_mcp", "name": "mcp__ctx__search", "input": {"query": "build error"}}], UA),
    res(ts(0, 4), "toolu_bash", "On branch main"),
    res(ts(0, 5), "toolu_mcp", "one hit"),
    asst(ts(0, 8), "msg_b", "claude-sonnet-4-5", [{"type": "tool_use", "id": "toolu_agent", "name": "Agent", "input": {"description": "explore", "prompt": "find the failing test", "subagent_type": "Explore"}}],
         {"input_tokens": 7, "output_tokens": 30, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0,
          "iterations": [{"model": "claude-opus-4-5", "input_tokens": 5, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
                         {"model": "claude-sonnet-4-5", "input_tokens": 7, "output_tokens": 30, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}]}),
    res(ts(0, 21), "toolu_agent", "found it in test_x"),
    asst(ts(0, 23), "msg_c", "claude-sonnet-4-5", [{"type": "text", "text": "Fixed: the test imported a removed module."}], {"input_tokens": 3, "output_tokens": 12, "cache_read_input_tokens": 200, "cache_creation_input_tokens": 0}),
    cl("user", ts(5), {"role": "user", "content": "now remove the tmp dir"}, promptId="p2"),
    asst(ts(5, 2), "msg_d", "claude-sonnet-4-5", [{"type": "tool_use", "id": "toolu_rm", "name": "Bash", "input": {"command": "cd /home/u/proj && rm -rf tmp"}}], {"input_tokens": 4, "output_tokens": 8, "cache_read_input_tokens": 300, "cache_creation_input_tokens": 0}),
    res(ts(5, 10), "toolu_rm", "The user doesn't want to proceed with this tool use. The tool use was rejected.", True),
    asst(ts(5, 12), "msg_e", "<synthetic>", [{"type": "text", "text": "API Error: Rate limited"}], {"input_tokens": 0, "output_tokens": 0}, isApiErrorMessage=True, error="rate_limit", apiErrorStatus=429),
])
SUB = P + "/" + SID + "/subagents/agent-a1b2c3"
wj(SUB + ".meta.json", {"agentType": "Explore", "description": "explore", "model": "claude-haiku-4-5", "toolUseId": "toolu_agent"})
def scl(type_, t, msg):
    o = cl(type_, t, msg); o["isSidechain"] = True; o["agentId"] = "a1b2c3"; return o
w(SUB + ".jsonl", [
    scl("user", ts(0, 9), {"role": "user", "content": "find the failing test"}),
    scl("assistant", ts(0, 12), {"id": "msg_s1", "type": "message", "role": "assistant", "model": "claude-haiku-4-5", "content": [{"type": "tool_use", "id": "toolu_grep", "name": "Grep", "input": {"pattern": "import old"}}], "usage": {"input_tokens": 20, "output_tokens": 6, "cache_read_input_tokens": 50, "cache_creation_input_tokens": 0}}),
    scl("user", ts(0, 15), {"role": "user", "content": [{"tool_use_id": "toolu_grep", "type": "tool_result", "content": "test_x.py:1"}]}),
    scl("assistant", ts(0, 19), {"id": "msg_s2", "type": "message", "role": "assistant", "model": "claude-haiku-4-5", "content": [{"type": "text", "text": "found it in test_x"}], "usage": {"input_tokens": 25, "output_tokens": 9, "cache_read_input_tokens": 50, "cache_creation_input_tokens": 0}}),
])
wj(H + "/.claude.json", {"oauthAccount": {"billingType": "stripe_subscription", "organizationType": "claude_max"}})

# ── codex ──
H = R + "/codex"
CID = "22222222-2222-4222-8222-222222222222"; SUBID = "33333333-3333-4333-8333-333333333333"
D = H + "/.codex/sessions/2026/09/01"
def cx(t, type_, payload): return {"timestamp": t, "type": type_, "payload": payload}
def tc(t, inp, cached, out, reason=0):
    return cx(t, "event_msg", {"type": "token_count", "info": {"total_token_usage": {"input_tokens": inp, "cached_input_tokens": cached, "output_tokens": out, "reasoning_output_tokens": reason, "total_tokens": inp + out}, "last_token_usage": {}}, "rate_limits": None})
w(D + "/rollout-2026-09-01T10-00-00-" + CID + ".jsonl", [
    cx(ts(0), "session_meta", {"id": CID, "timestamp": ts(0), "cwd": CWD, "originator": "codex_cli_rs", "cli_version": "0.120.0", "model_provider": "openai", "git": {"branch": "main", "repository_url": "https://github.com/u/proj.git"}}),
    cx(ts(0), "turn_context", {"cwd": CWD, "model": "gpt-5.2-codex"}),
    cx(ts(0, 1), "event_msg", {"type": "task_started"}),
    cx(ts(0, 1), "response_item", {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "add a test"}]}),
    cx(ts(0, 3), "response_item", {"type": "reasoning", "summary": [{"type": "summary_text", "text": "Look at files"}]}),
    cx(ts(0, 3), "response_item", {"type": "function_call", "name": "exec_command", "arguments": "{\"cmd\":\"ls tests\"}", "call_id": "call_ls"}),
    tc(ts(0, 3), 1000, 800, 50, 20),
    cx(ts(0, 3), "event_msg", {"type": "token_count", "info": None, "rate_limits": {"primary": {"used_percent": 5.0, "window_minutes": 300, "resets_at": 1788000000}}}),
    cx(ts(0, 4), "response_item", {"type": "function_call_output", "call_id": "call_ls", "output": "Process exited with code 0\nOutput:\ntest_a.py"}),
    tc(ts(0, 4), 1000, 800, 50, 20),
    cx(ts(0, 6), "response_item", {"type": "function_call", "name": "spawn_agent", "arguments": "{\"agent_type\":\"worker\",\"message\":\"write test_b\"}", "call_id": "call_spawn"}),
    tc(ts(0, 6), 2500, 1800, 90, 30),
    cx(ts(0, 7), "response_item", {"type": "function_call_output", "call_id": "call_spawn", "output": "{\"agent_id\":\"" + SUBID + "\"}"}),
    cx(ts(0, 20), "response_item", {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Started a worker."}]}),
    tc(ts(0, 20), 4000, 3000, 120, 30),
    cx(ts(0, 21), "event_msg", {"type": "task_complete"}),
    cx(ts(5), "event_msg", {"type": "task_started"}),
    cx(ts(5), "response_item", {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "ask the worker for status"}]}),
    cx(ts(5, 2), "response_item", {"type": "function_call", "name": "send_input", "arguments": "{\"id\":\"" + SUBID + "\",\"message\":\"status?\"}", "call_id": "call_send"}),
    tc(ts(5, 2), 100, 0, 10),
    cx(ts(5, 3), "response_item", {"type": "function_call_output", "call_id": "call_send", "output": "ok"}),
    cx(ts(5, 9), "event_msg", {"type": "turn_aborted", "reason": "interrupted"}),
])
w(D + "/rollout-2026-09-01T10-00-06-" + SUBID + ".jsonl", [
    cx(ts(0, 6), "session_meta", {"id": SUBID, "timestamp": ts(0, 6), "cwd": CWD, "cli_version": "0.120.0", "parent_thread_id": CID, "source": {"subagent": {"thread_spawn": {"parent_thread_id": CID, "depth": 1, "agent_role": "worker", "agent_nickname": "Ada"}}}}),
    cx(ts(0, 6), "turn_context", {"cwd": CWD, "model": "gpt-5.2-codex-mini"}),
    cx(ts(0, 7), "response_item", {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "write test_b"}]}),
    cx(ts(0, 9), "response_item", {"type": "function_call", "name": "apply_patch", "arguments": "{\"input\":\"*** Begin Patch\\n*** Add File: tests/test_b.py\\n+def test_b(): pass\\n*** End Patch\"}", "call_id": "call_patch"}),
    tc(ts(0, 9), 300, 0, 40),
    cx(ts(0, 10), "response_item", {"type": "function_call_output", "call_id": "call_patch", "output": "Success"}),
    cx(ts(0, 12), "response_item", {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "test_b written"}]}),
    tc(ts(0, 12), 700, 300, 60),
    cx(ts(5, 4), "response_item", {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "status?"}]}),
    cx(ts(5, 6), "response_item", {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "done"}]}),
    tc(ts(5, 6), 900, 500, 70),
])
wj(H + "/.codex/auth.json", {"auth_mode": "apikey"})

# ── gemini (raw upsert stream: the normalizing source applies the rewind) ──
H = R + "/gemini"
GID = "44444444-4444-4444-8444-444444444444"
G = H + "/.gemini/tmp/proj"
os.makedirs(G + "/chats", exist_ok=True)
open(G + "/.project_root", "w").write(CWD)
def gm(mid, t, model, content=None, tokens=None, calls=None):
    o = {"id": mid, "timestamp": t, "type": "gemini"}
    if content is not None: o["content"] = content
    if model: o["model"] = model
    if tokens: o["tokens"] = tokens
    if calls: o["toolCalls"] = calls
    return o
def tk(i, o, c=0, th=0): return {"input": i, "output": o, "cached": c, "thoughts": th, "tool": 0, "total": i + o + th}
def call(cid, name, args, out, st, t): return {"id": cid, "name": name, "args": args, "result": [{"functionResponse": {"id": cid, "name": name, "response": {"output": out}}}], "status": st, "timestamp": t}
w(G + "/chats/session-2026-09-01T10-00-44444444.jsonl", [
    {"sessionId": GID, "projectHash": "abc123", "startTime": ts(0), "lastUpdated": ts(9), "kind": "main"},
    {"id": "u1", "timestamp": ts(0), "type": "user", "content": [{"text": "list the files"}]},
    gm("g1", ts(0, 3), "gemini-2.5-pro", "", tk(1000, 20, 600, 15)),
    gm("g1", ts(0, 3), "gemini-2.5-pro", "", None, [call("run_shell_command__1", "run_shell_command", {"command": "ls"}, "a.py", "success", ts(0, 4))]),
    gm("g2", ts(0, 6), "gemini-2.5-flash", "Two files.", tk(1200, 10, 900)),
    {"id": "u2", "timestamp": ts(3), "type": "user", "content": [{"text": "delete a.py"}]},
    gm("g3", ts(3, 2), "gemini-2.5-flash", "", tk(1300, 8)),
    {"$rewindTo": "u2"},
    {"id": "u3", "timestamp": ts(4), "type": "user", "content": [{"text": "rename a.py to b.py"}]},
    gm("g4", ts(4, 2), "gemini-2.5-flash", "", tk(1400, 12, 1000)),
    gm("g4", ts(4, 2), "gemini-2.5-flash", "", None, [call("run_shell_command__2", "run_shell_command", {"command": "mv a.py b.py"}, "", "error", ts(4, 3))]),
    gm("g5", ts(4, 5), "gemini-2.5-flash", "mv failed.", tk(1500, 6, 1100)),
])
wj(H + "/.gemini/settings.json", {"security": {"auth": {"selectedType": "gemini-api-key"}}})

# ── pi ──
H = R + "/pi"
PID = "55555555-5555-4555-8555-555555555555"
def pe(eid, t, msg): return {"type": "message", "id": eid, "parentId": None, "timestamp": t, "message": msg}
def pu(i, o, cr, cost): return {"input": i, "output": o, "cacheRead": cr, "cacheWrite": 0, "totalTokens": i + o + cr, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": cost}}
w(H + "/.pi/agent/sessions/--home-u-proj--/2026-09-01T10-00-00-000Z_" + PID + ".jsonl", [
    {"type": "session", "version": 3, "id": PID, "timestamp": ts(0), "cwd": CWD},
    {"type": "model_change", "id": "mc1", "parentId": None, "timestamp": ts(0), "provider": "openrouter", "modelId": "anthropic/claude-sonnet-4.5"},
    pe("e1", ts(0, 1), {"role": "user", "content": [{"type": "text", "text": "run the tests"}], "timestamp": 1788256801000}),
    pe("e2", ts(0, 4), {"role": "assistant", "content": [{"type": "toolCall", "id": "tc_bash", "name": "bash", "arguments": {"command": "npm test"}}], "api": "openai-completions", "provider": "openrouter", "model": "anthropic/claude-sonnet-4.5", "responseModel": "anthropic/claude-4.5-sonnet-20250929", "usage": pu(50, 20, 400, 0.002), "stopReason": "toolUse"}),
    pe("e3", ts(0, 9), {"role": "toolResult", "toolCallId": "tc_bash", "toolName": "bash", "content": [{"type": "text", "text": "1 passing"}], "isError": False}),
    pe("e4", ts(0, 11), {"role": "assistant", "content": [{"type": "text", "text": "All tests pass."}], "api": "anthropic-messages", "provider": "anthropic", "model": "claude-haiku-4-5", "usage": pu(5, 8, 450, 0.0004), "stopReason": "stop"}),
])
wj(H + "/.pi/agent/auth.json", {"anthropic": {"type": "oauth"}, "openrouter": {"type": "api_key"}})

# ── kiro ──
H = R + "/kiro"
KID = "66666666-6666-4666-8666-666666666666"
K = H + "/.kiro/sessions/cli/" + KID
def kl(kind, data): return {"version": "v1", "kind": kind, "data": data}
w(K + ".jsonl", [
    kl("Prompt", {"content": [{"kind": "text", "data": "show disk usage"}]}),
    kl("AssistantMessage", {"content": [{"kind": "text", "data": "Checking."}, {"kind": "toolUse", "data": {"toolUseId": "k_t1", "name": "execute_bash", "input": {"command": "df -h", "__tool_use_purpose": "disk"}}}]}),
    kl("ToolResults", {"content": [{"kind": "toolResult", "data": {"toolUseId": "k_t1", "status": "success", "content": [{"kind": "text", "data": "/dev/sda1 50%"}]}}]}),
    kl("AssistantMessage", {"content": [{"kind": "text", "data": "Half full."}]}),
    kl("Prompt", {"content": [{"kind": "text", "data": "and memory?"}]}),
    kl("AssistantMessage", {"content": [{"kind": "toolUse", "data": {"toolUseId": "k_t2", "name": "execute_bash", "input": {"command": "free -m"}}}]}),
    kl("ToolResults", {"content": [{"kind": "toolResult", "data": {"toolUseId": "k_t2", "status": "error", "content": [{"kind": "text", "data": "free: not found"}]}}]}),
    kl("AssistantMessage", {"content": [{"kind": "text", "data": "No free on this box."}]}),
])
wj(K + ".json", {"session_id": KID, "cwd": CWD, "title": "disk check", "session_state": {"conversation_metadata": {"user_turn_metadatas": [
    {"end_timestamp": "2026-09-01T10:00:20.123456789Z", "input_token_count": 900, "output_token_count": 40, "metering_usage": [{"unit": "credit", "value": 0.3}]},
    {"end_timestamp": "2026-09-01T10:02:10.000000000Z", "input_token_count": 1100, "output_token_count": 25, "metering_usage": [{"unit": "credit", "value": 0.2}]}]}}})

# ── fx ──
H = R + "/fx"
FID = "fx-77777777"
F = H + "/.fx/sessions/" + FID
B = 1788256800000
def fe(seq, dt, ev): return {"seq": seq, "timestamp_ms": B + dt, "event": ev}
w(F + "/events.jsonl", [
    fe(1, 0, {"turn_started": {}}),
    fe(2, 40000, {"user": {"text": "count lines"}}),
    fe(3, 40000, {"tool_call": {"tool_name": "shell", "call_id": "f_c1", "arguments_json": "{\"command\":\"wc -l *.py\"}"}}),
    fe(4, 40000, {"tool_result": {"call_id": "f_c1", "status": "success", "preview": "{\"output\":\"12 a.py\"}", "output_bytes": 7}}),
    fe(5, 40000, {"assistant": {"text": "12 lines."}}),
    fe(6, 40000, {"turn_completed": {"turn_summary": {"turn_duration_ms": 30000}}}),
    fe(7, 200000, {"user": {"text": "and in tests?"}}),
    fe(8, 200000, {"tool_call": {"tool_name": "shell", "call_id": "f_c2", "arguments_json": "{\"command\":\"wc -l tests/*.py\"}"}}),
    fe(9, 200000, {"tool_result": {"call_id": "f_c2", "status": "failed", "preview": "{\"error\":\"no such file\"}", "output_bytes": 13}}),
    fe(10, 200000, {"turn_completed": {"turn_summary": {"turn_duration_ms": 12000}}}),
])
wj(F + "/session.json", {"title": "line count", "workspace_root": CWD, "model": "fx-large"})
wj(F + "/usage-v2.json", {"snapshot": {"input_tokens": 3000, "output_tokens": 200, "cache_read_tokens": 1000, "cache_write_tokens": 50, "total_cost": 0.04, "lines_added": 0, "lines_removed": 0}})

# ── opencode: SQL that builds a 2.x DB (sqlite3 CLI at check time) ──
H = R + "/opencode"
os.makedirs(H, exist_ok=True)
OS_ = "ses_oc0001"
def row(seq, typ, t, data): return (seq, typ, t, json.dumps(data, separators=(",", ":")))
rows = [
    row(0, "user", 1788256800000, {"time": {"created": 1788256800000}, "text": "add a readme"}),
    row(1, "assistant", 1788256801000, {"time": {"created": 1788256801000, "completed": 1788256805000}, "agent": "build", "model": {"id": "claude-sonnet-4-5", "providerID": "anthropic"},
        "content": [{"type": "reasoning", "text": "need a file"}, {"type": "tool", "id": "oc_t1", "name": "write", "state": {"status": "completed", "input": {"filePath": CWD + "/README.md", "content": "# proj\n"}, "content": [{"type": "text", "text": "Wrote file"}]}, "time": {"created": 1788256803000, "ran": 1788256803000, "completed": 1788256804000}}],
        "cost": 0.01, "tokens": {"input": 30, "output": 40, "reasoning": 10, "cache": {"read": 500, "write": 100}}}),
    row(2, "assistant", 1788256806000, {"time": {"created": 1788256806000, "completed": 1788256808000}, "agent": "build", "model": {"id": "gpt-5.2", "providerID": "openai"},
        "content": [{"type": "text", "text": "README added."}], "cost": 0.003, "tokens": {"input": 20, "output": 5, "reasoning": 0, "cache": {"read": 400, "write": 0}}}),
    row(3, "idle", 1788256809000, {"time": {"created": 1788256809000}, "outcome": "completed"}),
]
sql = ["CREATE TABLE `session_v2` (`id` text PRIMARY KEY, `project_id` text NOT NULL, `workspace_id` text, `parent_id` text, `fork_session_id` text, `fork_boundary` text, `slug` text NOT NULL, `directory` text NOT NULL, `path` text, `title` text, `version` text NOT NULL, `share_url` text, `summary_additions` integer, `summary_deletions` integer, `summary_files` integer, `summary_diffs` text, `metadata` text, `cost` real DEFAULT 0 NOT NULL, `tokens_input` integer DEFAULT 0 NOT NULL, `tokens_output` integer DEFAULT 0 NOT NULL, `tokens_reasoning` integer DEFAULT 0 NOT NULL, `tokens_cache_read` integer DEFAULT 0 NOT NULL, `tokens_cache_write` integer DEFAULT 0 NOT NULL, `revert` text, `permission` text, `agent` text, `model` text, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `time_idle` integer, `time_viewed` integer, `idle_outcome` text, `time_compacting` integer, `time_archived` integer, `time_suspended` integer, `resume_attempts` integer DEFAULT 0 NOT NULL);",
       "CREATE TABLE `session_message` (`id` text PRIMARY KEY, `session_id` text NOT NULL, `type` text NOT NULL, `seq` integer NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL);",
       "insert into session_v2 (id,project_id,slug,directory,title,version,time_created,time_updated) values ('%s','global','readme','%s','readme','2.0.19',1788256800000,1788256809000);" % (OS_, CWD)]
for seq, typ, t, data in rows:
    sql.append("insert into session_message (id,session_id,type,seq,time_created,time_updated,data) values ('m%d','%s','%s',%d,%d,%d,'%s');" % (seq, OS_, typ, seq, t, t, data.replace("'", "''")))
open(H + "/opencode.sql", "w").write("\n".join(sql) + "\n")
wj(H + "/.local/share/opencode/auth.json", {"anthropic": {"type": "oauth"}, "openai": {"type": "api"}})
