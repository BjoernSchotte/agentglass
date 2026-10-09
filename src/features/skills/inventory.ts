// agentglass — installed skills, read-only: each harness's skill dirs, frontmatter only (first 4 KB), for advice A6
// ("listed, never loaded") where no listing is logged. Keeps name, scope, the description's byte length and the
// disable-model-invocation flag — never the description text. At most one scan per hour (skill-usage spec §8)
// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { HOME, readText, listDir } from "../../util/fs.ts";
import { type Obj, obj, parse } from "../../util/json.ts";

export interface InvSkill { name: string; harness: string; scope: string; descBytes: number; manual: boolean }
const MEMO = { at: 0, key: "", out: [] as InvSkill[] };
const HOUR = 3600000;

// frontmatter of one SKILL.md: name (else the dir), description length in bytes, manual-only flag; null = not a skill file
export function frontOf(text: string, dir: string): { name: string; descBytes: number; manual: boolean } | null {
  if (!text.startsWith("---")) return text ? { name: dir, descBytes: 0, manual: false } : null;
  const end = text.indexOf("\n---", 3); const fm = text.slice(3, end > 0 ? end : text.length);
  let name = ""; let desc = 0; let manual = false; let inDesc = false;
  for (const ln of fm.split("\n")) {
    const k = /^([A-Za-z_-]+):\s*(.*)$/.exec(ln);
    if (k) {
      inDesc = false;
      const key = k[1] ?? ""; const v = (k[2] ?? "").trim();
      if (key === "name") name = v.replace(/^["']|["']$/g, "");
      else if (key === "description") { inDesc = true; desc = v === ">" || v === "|" || v === ">-" || v === "|-" ? 0 : utf8(v); }
      else if (key === "disable-model-invocation") manual = v === "true";
      continue;
    }
    if (inDesc && /^\s+\S/.test(ln)) desc += utf8(ln.trim()) + 1; // a folded or literal block's lines
  }
  return { name: name || dir, descBytes: desc, manual };
}
function utf8(s: string): number { let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 2 : 3; } return n; }
function scanDir(out: InvSkill[], dir: string, harness: string, scope: string, prefix: string): void {
  for (const d of listDir(dir)) {
    if (d.startsWith(".") && d !== ".system") continue;
    if (d === ".system") { scanDir(out, join(dir, d), harness, "builtin", prefix); continue; }
    const f = frontOf(readText(join(dir, d, "SKILL.md"), 0, 4096), d); if (!f) continue;
    out.push({ name: prefix ? prefix + ":" + d : f.name, harness, scope, descBytes: f.descBytes, manual: f.manual });
  }
}
// enabled Claude plugins ("<plugin>@<marketplace>": true in settings.json) → their skills dirs under plugins/cache
function claudePlugins(out: InvSkill[], home: string): void {
  const st: Obj | null = parse(readText(join(home, ".claude", "settings.json"), 0, 262144));
  const en = st ? obj(st["enabledPlugins"]) : null; if (!en) return;
  for (const k of Object.keys(en)) {
    if (en[k] !== true) continue;
    const at = k.indexOf("@"); const plug = at > 0 ? k.slice(0, at) : k; const mk = at > 0 ? k.slice(at + 1) : "";
    const base = join(home, ".claude", "plugins", "cache", mk, plug);
    const vers = listDir(base).sort(); const v = vers[vers.length - 1] ?? ""; // the newest version dir
    if (v) scanDir(out, join(base, v, "skills"), "claude", "plugin", plug);
  }
}
// every installed skill this machine's harnesses would list; repos = project roots seen in the period
export function inventory(repos: string[], home = HOME): InvSkill[] {
  const key = home + "\n" + repos.join("\n");
  if (MEMO.key === key && Date.now() - MEMO.at < HOUR) return MEMO.out;
  const out: InvSkill[] = [];
  scanDir(out, join(home, ".claude", "skills"), "claude", "user", "");
  claudePlugins(out, home);
  scanDir(out, join(home, ".codex", "skills"), "codex", "user", "");
  scanDir(out, join(home, ".agents", "skills"), "codex", "user", "");
  scanDir(out, join(home, ".gemini", "skills"), "gemini", "user", "");
  scanDir(out, join(home, ".config", "opencode", "skills"), "opencode", "user", "");
  scanDir(out, join(home, ".pi", "agent", "skills"), "pi", "user", "");
  for (const r of repos) {
    if (!r || r === home) continue;
    scanDir(out, join(r, ".claude", "skills"), "claude", "project", "");
    scanDir(out, join(r, ".agents", "skills"), "codex", "project", "");
    scanDir(out, join(r, ".opencode", "skills"), "opencode", "project", "");
    scanDir(out, join(r, ".gemini", "skills"), "gemini", "project", "");
  }
  MEMO.at = Date.now(); MEMO.key = key; MEMO.out = out;
  return out;
}
