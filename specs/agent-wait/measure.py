#!/usr/bin/env python3
# read-only measurement for specs/agent-wait: tool-call wall time, command families, cross-agent overlap
# usage: python3 specs/agent-wait/measure.py [days]   (reads ~/.claude/projects and ~/.codex/sessions; writes nothing)
# SPDX-License-Identifier: Apache-2.0
import json, glob, os, re, sys, time, statistics, collections
DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 30
CUT = time.time() - DAYS * 86400
H = os.path.expanduser('~')

def ts(s):
    try: return time.mktime(time.strptime(s[:19], '%Y-%m-%dT%H:%M:%S')) - time.timezone + (float('0' + s[19:23]) if s[19:20] == '.' else 0)
    except Exception: return None

WRAP = {'sudo','env','timeout','nice','nohup','time','command','exec','caffeinate','rtk','proxy','stdbuf','ionice','flock'}
FILTER = {'cat','grep','rg','sed','head','tail','awk','jq','wc','sort','uniq','tee','less','cut','tr','xargs','column','python3 -c'}
TRIV = {'cd','pushd','popd','export','source','.','set','unset','ulimit','true','false','echo','printf','for','while','until','if','then','else','do','done','fi','esac','case','mkdir','test','[','local','read','trap','wait'}
PM = {'npm','pnpm','yarn','bun'}
RUNNERS = {'npx','pnpx','bunx','uvx'}
def words(seg):
    w = seg.strip().split()
    i = 0
    while i < len(w):
        x = w[i]
        if re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', x): i += 1; continue
        if x in WRAP:
            i += 1
            while i < len(w) and (w[i].startswith('-') or re.match(r'^[0-9.]+[smhd]?$', w[i])): i += 1
            continue
        break
    return [re.sub(r'^[("\'{]+|["\')};]+$', '', y) for y in w[i:]]

def base(p): return p.rsplit('/', 1)[-1]
def fam_seg(w):
    if not w: return ''
    p = base(w[0]); a = [x for x in w[1:] if not x.startswith('-')]
    if p in TRIV: return ''
    if p in PM:
        if not a: return p
        s = a[0]
        if s in ('run', 'run-script') and len(a) > 1: return p + ' run ' + a[1]
        if s in ('exec', 'dlx', 'x') and len(a) > 1: return base(a[1])
        if s in ('t', 'tst'): s = 'test'
        if s in ('i', 'ci', 'add', 'install'): return p + ' install'
        return p + ' ' + s
    if p in RUNNERS: return fam_seg(a) if a else p
    if p in ('python', 'python3') and len(w) > 2 and w[1] == '-m': return base(w[2])
    if p == 'uv' and a[:1] == ['run']:
        r = w[w.index('run') + 1:]
        while r and r[0].startswith('-'): r = r[1:]
        return fam_seg(r) or 'uv run'
    if p in ('cargo', 'go', 'make', 'docker', 'gh', 'git', 'kubectl', 'just', 'mvn', 'gradle', 'dotnet', 'terraform', 'composer', 'mix', 'flutter', 'scriptc', 'herdr', 'tmux', 'agentglass'):
        sub = a[0] if a else ''
        if p == 'gh' and len(a) > 1: sub = a[0] + ' ' + a[1]
        if p == 'go' and sub == 'tool' and len(a) > 1: sub = 'tool ' + a[1]
        return (p + ' ' + sub).strip()
    if p in ('sh', 'bash', 'zsh') and a: return p + ' ' + base(a[0]) if not a[0].startswith('-') else p
    if p in ('node', 'tsx', 'deno', 'ts-node') and a: return p + ' ' + base(a[0])
    return p

HEREDOC = re.compile(r"<<-?\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?[^\n]*\n.*?\n\s*\1\s*(?=\n|$)", re.S)
def family(cmd):
    cmd = HEREDOC.sub(lambda m: m.group(0).split('\n', 1)[0], cmd)
    first = ''
    for seg in re.split(r'&&|\|\||;|\n|\|', cmd):
        f = fam_seg(words(seg))
        if not f: continue
        if f.split(' ')[0] in FILTER:
            if not first: first = f
            continue
        return f[:60]
    return first[:60] or 'sh'
KINDS = [('test', r'(^| )(test|tests|vitest|jest|pytest|mocha|playwright|check\.sh|storybook:test\S*|test:\S+|e2e)( |$)|^go test|^cargo test|^mix test|^rspec'),
 ('typecheck', r'tsc|typecheck|type-check|mypy|pyright|check-types|svelte-check|vue-tsc|cargo check'),
 ('lint', r'lint|eslint|biome|ruff|clippy|prettier|shellcheck|golangci|stylelint|fmt|format'),
 ('build', r'build|compile|^make|scriptc|webpack|vite( |$)|esbuild|rollup|^next|bundle'),
 ('install', r' install|^pip|^uv sync|^npm ci|^bundle install|^go mod'),
 ('ci', r'^gh (run|pr checks)|^gh workflow|act( |$)'),
 ('wait', r'^sleep|until|^wait|^timeout|while')]
def kind(f):
    for k, r in KINDS:
        if re.search(r, f): return k
    return 'other'

calls = []  # (agent, harness, tool, fam, t0, t1, err)
def claude():
    fs = [f for f in glob.glob(H + '/.claude/projects/**/*.jsonl', recursive=True) if os.path.getmtime(f) >= CUT]
    for f in fs:
        pend = {}
        try: fh = open(f, errors='replace')
        except Exception: continue
        for l in fh:
            if '"tool_use"' not in l and '"tool_result"' not in l: continue
            try: j = json.loads(l)
            except Exception: continue
            t = ts(j.get('timestamp', '') or '')
            if t is None: continue
            c = (j.get('message') or {}).get('content')
            if not isinstance(c, list): continue
            for b in c:
                if not isinstance(b, dict): continue
                if b.get('type') == 'tool_use':
                    inp = b.get('input') or {}
                    cmd = inp.get('command') if b.get('name') == 'Bash' and isinstance(inp.get('command'), str) else ''
                    bg = bool(inp.get('run_in_background')) if isinstance(inp, dict) else False
                    pend[b.get('id')] = (t, b.get('name', ''), cmd, bg)
                elif b.get('type') == 'tool_result':
                    p = pend.pop(b.get('tool_use_id'), None)
                    if not p or t < CUT: continue
                    t0, name, cmd, bg = p
                    if t < t0 or t - t0 > 86400: continue
                    calls.append((f, 'claude', name, family(cmd) if cmd else '', t0, t, bool(b.get('is_error')), bg))
CMDRE = re.compile(r'exec_command\(\s*\{[^}]*?\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'|`(?:[^`\\]|\\.)*`)')
def codex():
    fs = [f for f in glob.glob(H + '/.codex/sessions/**/*.jsonl', recursive=True) if os.path.getmtime(f) >= CUT]
    for f in fs:
        pend = {}
        try: fh = open(f, errors='replace')
        except Exception: continue
        for l in fh:
            if '"response_item"' not in l or 'call' not in l: continue
            try: j = json.loads(l)
            except Exception: continue
            p = j.get('payload') or {}; ty = p.get('type'); t = ts(j.get('timestamp', '') or '')
            if t is None: continue
            if ty in ('function_call', 'custom_tool_call'):
                name = p.get('name', ''); cmd = ''
                if ty == 'custom_tool_call':
                    m = CMDRE.search(p.get('input', '') or '')
                    if m:
                        lit = m.group(1)
                        try: cmd = json.loads(lit) if lit.startswith('"') else lit[1:-1]
                        except Exception: cmd = lit[1:-1]
                else:
                    try: a = json.loads(p.get('arguments') or '{}')
                    except Exception: a = {}
                    v = a.get('command') if isinstance(a, dict) else None
                    if isinstance(v, list): cmd = v[2] if len(v) >= 3 and v[1] in ('-c', '-lc') else ' '.join(map(str, v))
                    elif isinstance(v, str): cmd = v
                    elif isinstance(a, dict) and isinstance(a.get('cmd'), str): cmd = a['cmd']
                pend[p.get('call_id')] = (t, name, cmd)
            elif ty in ('function_call_output', 'custom_tool_call_output'):
                q = pend.pop(p.get('call_id'), None)
                if not q or t < CUT: continue
                t0, name, cmd = q
                if t < t0 or t - t0 > 86400: continue
                out = str(p.get('output', ''))[:600]
                err = bool(re.search(r'Process exited with code [1-9]|Exit code:? [1-9]|Script failed|Script error', out))
                calls.append((f, 'codex', name, family(cmd) if cmd else '', t0, t, err, False))
claude(); codex()
print('calls', len(calls), 'days', DAYS)

# active agent time per agent: union of event gaps <= 5 min (approximation of Day.act) built from call spans
by_agent = collections.defaultdict(list)
for c in calls: by_agent[c[0]].append((c[4], c[5]))
active = 0.0
for a, sp in by_agent.items():
    sp.sort(); s, e = sp[0]
    for x, y in sp[1:]:
        if x <= e + 300: e = max(e, y)
        else: active += e - s; s, e = x, y
    active += e - s
tool_total = sum(c[5] - c[4] for c in calls)
print('agents', len(by_agent), 'active h (call-span union, gaps<=5m)', round(active / 3600, 1), 'tool wall h', round(tool_total / 3600, 1))

def q(v, p):
    v = sorted(v); return v[min(len(v) - 1, int(p * len(v)))] if v else 0
tools = collections.defaultdict(list); terr = collections.Counter()
for c in calls: tools[c[2]].append(c[5] - c[4]); terr[c[2]] += c[6]
print('\n== tools by total wall time')
for k, v in sorted(tools.items(), key=lambda kv: -sum(kv[1]))[:14]:
    print(f'{k[:28]:28} n={len(v):6} total={sum(v)/3600:7.1f}h share={sum(v)/tool_total*100:5.1f}% p50={q(v,.5):7.1f}s p95={q(v,.95):7.1f}s err={terr[k]/len(v)*100:4.1f}%')

shell = [c for c in calls if c[3]]
fams = collections.defaultdict(list); ferr = collections.Counter()
for c in shell: fams[c[3]].append(c[5] - c[4]); ferr[c[3]] += c[6]
st = sum(c[5] - c[4] for c in shell)
print('\n== shell families by total wall time; shell total h', round(st / 3600, 1), 'families', len(fams))
for k, v in sorted(fams.items(), key=lambda kv: -sum(kv[1]))[:30]:
    print(f'{k[:30]:30} n={len(v):6} total={sum(v)/3600:6.1f}h shell%={sum(v)/st*100:5.1f} p50={q(v,.5):6.1f}s p95={q(v,.95):7.1f}s err={ferr[k]/len(v)*100:4.1f}%')
cum = 0; top = sorted((sum(v) for v in fams.values()), reverse=True)
for i, v in enumerate(top):
    cum += v
    if cum >= .8 * st: print('families covering 80% of shell time:', i + 1); break

# overlap per family, across agents: calls >= MIN s only (heavy)
MIN = float(os.environ.get('MIN', '5'))
print(f'\n== cross-agent overlap per family (calls >= {MIN}s)')
rows = []
for fam, _ in sorted(fams.items(), key=lambda kv: -sum(kv[1]))[:40]:
    cs = sorted([c for c in shell if c[3] == fam and c[5] - c[4] >= MIN], key=lambda c: c[4])
    if len(cs) < 5: continue
    ev = []
    for c in cs: ev.append((c[4], 1, c[0])); ev.append((c[5], -1, c[0]))
    ev.sort(key=lambda e: (e[0], e[1]))
    cur = collections.Counter(); peak = 0; peak_t = 0; t_ge2 = 0.0; t_ge3 = 0.0; last = None
    for t, d, a in ev:
        nag = len([x for x in cur if cur[x] > 0])
        if last is not None:
            if nag >= 2: t_ge2 += t - last
            if nag >= 3: t_ge3 += t - last
        cur[a] += d; last = t
        nag = len([x for x in cur if cur[x] > 0])
        if nag > peak: peak = nag; peak_t = t
    alone = []; over = []
    for c in cs:
        o = any(d[0] != c[0] and d[4] < c[5] and d[5] > c[4] and min(d[5], c[5]) - max(d[4], c[4]) >= .5 * (c[5] - c[4]) for d in cs)
        (over if o else alone).append(c[5] - c[4])
    rows.append((fam, len(cs), peak, time.strftime('%m-%d %H:%M', time.localtime(peak_t)), t_ge2 / 3600, t_ge3 / 3600, len(over), q(alone, .5), q(over, .5), q(alone, .95), q(over, .95)))
for r in sorted(rows, key=lambda r: -r[4])[:20]:
    print(f'{r[0][:26]:26} n={r[1]:5} peak={r[2]:2}@{r[3]} >=2:{r[4]:5.1f}h >=3:{r[5]:5.2f}h overlapped={r[6]:5} p50 alone/over={r[7]:6.1f}/{r[8]:6.1f}s p95={r[9]:6.1f}/{r[10]:6.1f}s')

# any heavy command (>= 30s) concurrency across agents, regardless of family
cs = [c for c in shell if c[5] - c[4] >= 30]
ev = sorted([(c[4], 1) for c in cs] + [(c[5], -1) for c in cs], key=lambda e: (e[0], e[1]))
cur = 0; peak = 0; hist = collections.Counter(); last = None
for t, d in ev:
    if last is not None: hist[cur] += t - last
    cur += d; last = t; peak = max(peak, cur)
print('\n== any shell call >= 30s, concurrent count -> hours:', {k: round(v / 3600, 1) for k, v in sorted(hist.items()) if k}, 'peak', peak, 'n', len(cs))
bg = [c for c in calls if c[7]]
print('claude run_in_background calls', len(bg))

kt = collections.defaultdict(list)
for c in shell: kt[kind(c[3])].append(c[5]-c[4])
print('\n== kinds (share of shell wall time)')
for k,v in sorted(kt.items(), key=lambda kv:-sum(kv[1])): print(f'{k:10} n={len(v):6} total={sum(v)/3600:6.1f}h share={sum(v)/st*100:5.1f}% p50={q(v,.5):6.1f}s p95={q(v,.95):6.1f}s')
# per agent union of tool spans vs active
tu = 0.0
for a, sp in by_agent.items():
    sp = sorted(sp); s0, e0 = sp[0]
    for x, y in sp[1:]:
        if x <= e0: e0 = max(e0, y)
        else: tu += e0 - s0; s0, e0 = x, y
    tu += e0 - s0
ask = sum(c[5]-c[4] for c in calls if c[2] in ('AskUserQuestion','request_user_input_async','request_user_input'))
print('tool-span union h', round(tu/3600,1), 'active h', round(active/3600,1), 'ask-user h', round(ask/3600,1))
# heavy kinds concurrency across agents (test/typecheck/lint/build), calls >= 10s
hv = [c for c in shell if kind(c[3]) in ('test','typecheck','lint','build') and c[5]-c[4] >= 10]
ev = sorted([(c[4], 1) for c in hv] + [(c[5], -1) for c in hv], key=lambda e: (e[0], e[1]))
cur = 0; peak = 0; hist = collections.Counter(); last = None
for t, d in ev:
    if last is not None: hist[cur] += t - last
    cur += d; last = t; peak = max(peak, cur)
print('heavy kinds (test/typecheck/lint/build >=10s) n', len(hv), 'concurrency->h', {k: round(v/3600,2) for k,v in sorted(hist.items()) if k}, 'peak', peak)
al=[];ov=[];ov3=[]
for c in hv:
    n = sum(1 for d in hv if d is not c and d[0]!=c[0] and d[4] < c[5] and d[5] > c[4] and min(d[5],c[5])-max(d[4],c[4]) >= .5*(c[5]-c[4]))
    (ov3 if n>=2 else ov if n==1 else al).append(c[5]-c[4])
print('heavy durations p50/p95 alone', round(q(al,.5),1), round(q(al,.95),1), len(al), '| +1 other', round(q(ov,.5),1), round(q(ov,.95),1), len(ov), '| +2..', round(q(ov3,.5),1), round(q(ov3,.95),1), len(ov3))
# same family only: alone vs overlapped, family-normalised ratio (median of per-family p50 ratio)
import statistics as S
rat=[]
for fam in set(c[3] for c in hv):
    cs=[c for c in hv if c[3]==fam]
    a=[];o=[]
    for c in cs:
        x = any(d is not c and d[0]!=c[0] and d[4]<c[5] and d[5]>c[4] for d in hv)
        (o if x else a).append(c[5]-c[4])
    if len(a)>=10 and len(o)>=10: rat.append((fam, round(q(o,.5)/max(q(a,.5),.1),2), len(a), len(o)))
print('per-family p50(overlapped with any heavy)/p50(alone):', sorted(rat, key=lambda r:-r[2]-r[3])[:14])
