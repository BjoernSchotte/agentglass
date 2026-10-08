#!/usr/bin/env python3
# agentglass — a small MCP stdio client for tests (stdlib only): starts the server, feeds it a script, prints every line
# the server writes as "<ms since start>\t<line>", and "<ms>\tEXIT <code>" when it exits.
#   python3 scripts/mcp-client.py [--cwd D] [--timeout S] -- <server argv…> < script.jsonl
# Script lines: a JSON-RPC message (sent as is), or a directive:
#   {"sleep": ms}                     wait
#   {"wait": id, "ms": N}             wait until the response with this id arrived (≤ N ms, default 60000)
#   {"close": true}                   close the server's stdin (prints "<ms>\tCLOSED")
#   {"expect_none": id, "ms": N}      wait N ms; a response with this id is a failure ("FAIL expect_none <id>")
#   {"raw": "text"}                   send text as is (no newline added: framing tests)
# After the script, stdin is closed; the client waits for the server's exit (≤ --timeout s, then kills it: exit 1).
# Exit: 0 when the server exited (any code) and no expectation failed, else 1.
import json, os, subprocess, sys, threading, time

def main():
    a = sys.argv[1:]; cwd = None; timeout = 30.0
    while a and a[0] != "--":
        if a[0] == "--cwd": cwd = a[1]; a = a[2:]
        elif a[0] == "--timeout": timeout = float(a[1]); a = a[2:]
        else: sys.exit("mcp-client: unknown option " + a[0])
    if not a or len(a) < 2: sys.exit("usage: mcp-client.py [--cwd D] [--timeout S] -- <server argv…> < script.jsonl")
    argv = a[1:]
    t0 = time.monotonic(); ms = lambda: int((time.monotonic() - t0) * 1000)
    p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, cwd=cwd)
    seen = {}; lock = threading.Condition(); out = sys.stdout
    def reader():
        for raw in p.stdout:
            line = raw.decode("utf-8", "replace").rstrip("\n")
            with lock:
                out.write("%d\t%s\n" % (ms(), line)); out.flush()
                try:
                    m = json.loads(line)
                    if isinstance(m, dict) and "id" in m and "method" not in m: seen[json.dumps(m["id"])] = True
                except ValueError: pass
                lock.notify_all()
    th = threading.Thread(target=reader, daemon=True); th.start()
    ok = True; closed = False
    def close():
        try: p.stdin.close()
        except BrokenPipeError: pass
    def send(b):
        try: p.stdin.write(b); p.stdin.flush()
        except (BrokenPipeError, ValueError): pass
    for l in sys.stdin:
        l = l.strip()
        if not l: continue
        d = json.loads(l)
        if isinstance(d, dict) and "sleep" in d: time.sleep(d["sleep"] / 1000.0)
        elif isinstance(d, dict) and "wait" in d:
            k = json.dumps(d["wait"]); end = time.monotonic() + d.get("ms", 60000) / 1000.0
            with lock:
                while k not in seen and time.monotonic() < end and p.poll() is None: lock.wait(0.05)
            if k not in seen: out.write("%d\tFAIL wait %s\n" % (ms(), k)); ok = False
        elif isinstance(d, dict) and "close" in d:
            if not closed:
                close(); closed = True
                with lock: out.write("%d\tCLOSED\n" % ms()); out.flush()
        elif isinstance(d, dict) and "expect_none" in d:
            time.sleep(d.get("ms", 1500) / 1000.0)
            if json.dumps(d["expect_none"]) in seen: out.write("%d\tFAIL expect_none %s\n" % (ms(), json.dumps(d["expect_none"]))); ok = False
        elif isinstance(d, dict) and "raw" in d: send(d["raw"].encode("utf-8"))
        else: send((json.dumps(d) + "\n").encode("utf-8"))
    if not closed: close()
    try: code = p.wait(timeout)
    except subprocess.TimeoutExpired:
        p.kill(); p.wait(); out.write("%d\tFAIL timeout: server still running after %gs\n" % (ms(), timeout)); sys.exit(1)
    th.join(2)
    out.write("%d\tEXIT %d\n" % (ms(), code)); out.flush()
    sys.exit(0 if ok else 1)

main()
