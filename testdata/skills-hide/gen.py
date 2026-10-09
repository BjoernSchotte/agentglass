# agentglass — the skills-hide fixture (scripts/skills-hide.test.sh): a Claude log, 2 h before now, that lists and loads
# four skills, each with its own text marker: pub (slash command, PUBSKILLTEXT), acme-x (Skill tool, ACMESKILLTEXT),
# secret (a Read of its SKILL.md, SECRETSKILLTEXT), notes (Skill tool, NOTESSKILLTEXT); then a failing Bash call.
#   python3 gen.py <out.jsonl> <session id> <cwd> [skill,…]   (default: all four; "stop" in the list: the log ends after
#   the loads, its last event a skill's text)
# SPDX-License-Identifier: Apache-2.0
import json, sys, datetime

out, sid, cwd = sys.argv[1], sys.argv[2], sys.argv[3]
only = sys.argv[4].split(",") if len(sys.argv) > 4 else ["pub", "acme-x", "secret", "notes"]
t0 = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0) - datetime.timedelta(hours=2)
n = [0]; pc = [0]; cr = [0]; L = []
def ts():
    n[0] += 1; return (t0 + datetime.timedelta(seconds=n[0])).strftime("%Y-%m-%dT%H:%M:%S.000Z")
def user(c, **kw):
    if isinstance(c, str): pc[0] += 1  # a prompt starts a turn; its meta lines share its promptId
    L.append(dict(parentUuid=None, isSidechain=False, promptId="p%d" % pc[0], type="user", sessionId=sid, cwd=cwd, timestamp=ts(), uuid="%s-u%d" % (sid[:4], len(L)), message=dict(role="user", content=c), **kw))
def asst(content, grow):
    i = len(L); u = dict(input_tokens=10, cache_read_input_tokens=cr[0], cache_creation_input_tokens=grow, output_tokens=20, cache_creation=dict(ephemeral_5m_input_tokens=grow, ephemeral_1h_input_tokens=0))
    cr[0] += grow
    L.append(dict(type="assistant", sessionId=sid, cwd=cwd, timestamp=ts(), uuid="%s-a%d" % (sid[:4], i), requestId="%s_req_%d" % (sid[:4], i), message=dict(id="%s_msg_%d" % (sid[:4], i), model="claude-sonnet-4-5", role="assistant", content=content, usage=u)))
def text(m): return m + " " + "lorem ipsum dolor sit amet " * 130
def tool(id, name, inp, grow): asst([dict(type="text", text="ok"), dict(type="tool_use", id=id, name=name, input=inp)], grow)
def meta(name, mark, src=None):
    kw = dict(isMeta=True); kw.update(dict(sourceToolUseID=src) if src else {})
    user([dict(type="text", text="Base directory for this skill: /h/.claude/skills/%s\n\n%s" % (name, text(mark)))], **kw)
L.append(dict(type="attachment", uuid="%s-att" % sid[:4], timestamp=ts(), sessionId=sid, attachment=dict(type="skill_listing", content="- pub: a public skill\n- acme-x: the acme helper\n  more about acme-x\n- secret: the secret review\n- notes: note taking", skillCount=4, isInitial=True)))
user("fix the login bug, maybe with acme-x")
asst([dict(type="text", text="ok")], 20000)
if "pub" in only:
    user("<command-name>/pub</command-name>\n<command-message>pub</command-message>\n<command-args></command-args>")
    meta("pub", "PUBSKILLTEXT")
if "acme-x" in only:
    tool("toolu_a", "Skill", dict(skill="acme-x"), 1500)
    user([dict(type="tool_result", tool_use_id="toolu_a", content="Launching skill: acme-x")])
    meta("acme-x", "ACMESKILLTEXT", "toolu_a")
if "secret" in only:
    tool("toolu_s", "Read", dict(file_path="/h/.claude/skills/secret/SKILL.md"), 1500)
    user([dict(type="tool_result", tool_use_id="toolu_s", content=text("SECRETSKILLTEXT"))])
if "notes" in only:
    tool("toolu_n", "Skill", dict(skill="notes"), 1500)
    user([dict(type="tool_result", tool_use_id="toolu_n", content="Launching skill: notes")])
    meta("notes", "NOTESSKILLTEXT", "toolu_n")
if "stop" in only:
    with open(out, "w") as f:
        for o in L: f.write(json.dumps(o, separators=(",", ":")) + "\n")
    sys.exit(0)
tool("toolu_b", "Bash", dict(command="git status"), 1500)
user([dict(type="tool_result", tool_use_id="toolu_b", content="fatal: not a git repository", is_error=True)])
for i in range(4): asst([dict(type="text", text="done %d" % i)], 200)
with open(out, "w") as f:
    for o in L: f.write(json.dumps(o, separators=(",", ":")) + "\n")
