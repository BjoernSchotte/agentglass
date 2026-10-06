// agentglass — `fleet serve` (the forced command of a viewer's key: read-only agentglass output, nothing else) and
// `fleet authorize` (prints the authorized_keys line for it; never writes SSH configuration). Fleet spec 4.2, 4.3
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { readWhole } from "../../util/fs.ts";
import { REDACT } from "../redact-on.ts";
import { cliError } from "../agentenv.ts";

// SSH_ORIGINAL_COMMAND → words, as POSIX sh splits plain words (no expansion of any kind): whitespace separates;
// '…' is literal; "…" takes \" and \\ (a backslash before anything else stays); a backslash outside quotes escapes the
// next character. Anything a shell would act on (` $ ; | & < > ( ) or a newline) outside quotes is refused
export function words(s: string): { w: string[]; err: string } {
  const w: string[] = []; let cur = ""; let inWord = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? "";
    if (c === " " || c === "\t") { if (inWord) { w.push(cur); cur = ""; inWord = false; } continue; }
    if (c === "\n" || "`$;|&<>()".indexOf(c) >= 0) return { w: [], err: "refused: shell syntax" };
    inWord = true;
    if (c === "'") {
      const j = s.indexOf("'", i + 1); if (j < 0) return { w: [], err: "refused: unbalanced quote" };
      cur += s.slice(i + 1, j); i = j; continue;
    }
    if (c === "\"") {
      let j = i + 1; let closed = false;
      for (; j < s.length; j++) {
        const d = s[j] ?? "";
        if (d === "\"") { closed = true; break; }
        if (d === "\\" && j + 1 < s.length && (s[j + 1] === "\"" || s[j + 1] === "\\")) { cur += s[j + 1] ?? ""; j++; continue; }
        if (d === "$" || d === "`") return { w: [], err: "refused: shell syntax" }; // expansions inside double quotes
        cur += d;
      }
      if (!closed) return { w: [], err: "refused: unbalanced quote" };
      i = j; continue;
    }
    if (c === "\\") { if (i + 1 >= s.length) return { w: [], err: "refused: unbalanced quote" }; const n = s[i + 1] ?? ""; if (n === "\n") return { w: [], err: "refused: shell syntax" }; cur += n; i++; continue; }
    cur += c;
  }
  if (inWord) w.push(cur);
  return { w, err: "" };
}
export const SERVE_REFUSED = "only fleet pull and --version are allowed";
function base(p: string): string { const i = p.lastIndexOf("/"); return i >= 0 ? p.slice(i + 1) : p; }
// the words of an allowed request → the child's argv (without the program word) and whether it asked for --redact
export function allowed(w: string[]): { args: string[]; redact: boolean; err: string } {
  const no = { args: [] as string[], redact: false, err: SERVE_REFUSED };
  if (w.length < 2 || base(w[0] ?? "") !== "agentglass") return no;
  const rest = w.slice(1);
  if (rest[0] === "--version") {
    if (rest.length === 1 || (rest.length === 2 && rest[1] === "--json")) return { args: rest, redact: false, err: "" };
    return no;
  }
  if (rest[0] !== "fleet" || rest[1] !== "pull") return no;
  const args = ["fleet", "pull"]; let redact = false; let days = false;
  for (let i = 2; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (a === "--redact" && !redact) { redact = true; args.push(a); continue; }
    if (a === "--days" && !days) {
      const v = rest[i + 1] ?? ""; i++;
      if (!/^\d{1,2}$/.test(v) || Number(v) < 1 || Number(v) > 90) return no;
      days = true; args.push(a); args.push(v); continue;
    }
    return no;
  }
  return { args, redact, err: "" };
}
const KEY_RE = /^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+\/=]+( [^\u0000-\u001f\u007f-\u009f"]{0,200})?$/; // the comment: no quote, no control character
// the authorized_keys line that limits pub to fleet serve (restrict: no pty, forwarding, agent, X11, ~/.ssh/rc)
export function keyLine(execPath: string, pub: string, from: string, redact: boolean): { line: string; err: string } {
  const k = pub.trim();
  if (!KEY_RE.test(k)) return { line: "", err: "not an OpenSSH public key line (ssh-ed25519, ssh-rsa, ecdsa-sha2-*, sk-*)" };
  if (from && !/^[0-9a-fA-F.:\/,*]+$/.test(from)) return { line: "", err: "--from must be addresses or CIDR ranges, comma-separated (e.g. 100.64.0.0/10)" };
  if (!execPath || /[\s"\\]/.test(execPath)) return { line: "", err: "this agentglass lives at a path with spaces or quotes (" + execPath + "): install it into a plain path such as ~/.local/bin" };
  return { line: "restrict," + (from ? "from=\"" + from + "\"," : "") + "command=\"" + execPath + " fleet serve" + (redact ? " --redact" : "") + "\" " + k, err: "" };
}
function err(msg: string): void { try { writeSync(2, "agentglass fleet serve: " + msg + "\n"); } catch (e) { /* closed */ } }
// `fleet serve [--redact]`, run by sshd as the forced command: SSH_ORIGINAL_COMMAND is the request
export function serveCli(args: string[]): void {
  for (let i = 2; i < args.length; i++) if (args[i] !== "--redact") cliError("usage", "unknown option " + (args[i] ?? "") + " for fleet serve", "agentglass fleet serve [--redact] (as an authorized_keys command=)", 2);
  const req = process.env["SSH_ORIGINAL_COMMAND"];
  if (req === undefined) { err("not run by sshd as a forced command (SSH_ORIGINAL_COMMAND is unset)\n  use it in authorized_keys: agentglass fleet authorize <key.pub> prints the line"); process.exit(2); }
  const ws = words(req);
  if (ws.err) { err(ws.err + " — " + SERVE_REFUSED); process.exit(126); }
  const a = allowed(ws.w);
  if (a.err) { err(a.err); process.exit(126); }
  // the serve flag (REDACT: this process's --redact, or AGENTGLASS_REDACT in its environment, which the child inherits)
  // forces redaction whatever the viewer asks; --redact in the child's argv is what makes it process-wide there
  const ch = a.args.slice(); if (REDACT && ch[0] === "fleet" && ch.indexOf("--redact") < 0) ch.push("--redact");
  const r = spawnSync(process.execPath, ch, { stdio: "inherit" });
  process.exit(typeof r.status === "number" ? r.status : 1);
}
// `fleet authorize <key.pub> [--from <cidr>] [--redact]`: prints the line; the user appends it to authorized_keys
export function authorizeCli(args: string[]): void {
  let file = ""; let from = ""; let redact = false;
  for (let i = 2; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--from") { from = args[i + 1] ?? ""; i++; if (!from) cliError("usage", "--from needs an address or CIDR range", "e.g. --from 100.64.0.0/10", 2); }
    else if (a === "--redact") redact = true;
    else if (!a.startsWith("-") && !file) file = a;
    else cliError("usage", "unknown option " + a + " for fleet authorize", "agentglass fleet authorize <key.pub> [--from <cidr>] [--redact]", 2);
  }
  if (!file) cliError("usage", "fleet authorize needs the viewer's public key file", "agentglass fleet authorize ~/agentglass-viewer.pub", 2);
  const r = readWhole(file, 16384);
  if (r.missing) cliError("usage", "no such file: " + file, "copy the viewer's .pub file to this host first", 2);
  if (r.err) cliError("usage", "cannot read " + file + " (" + r.err + ")", "a public key file is one line, at most 16 KB", 2);
  const k = keyLine(process.execPath, r.text, from, redact || REDACT); // --redact is a global flag: main takes it out of args
  if (k.err) cliError("usage", k.err, "", 2);
  try { writeSync(1, k.line + "\n"); } catch (e) { /* closed */ }
  process.exit(0);
}
