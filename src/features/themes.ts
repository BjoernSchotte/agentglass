// agentglass — color themes: --theme / AGENTGLASS_THEME / ~/.agentglass/theme, T cycles live and persists
// SPDX-License-Identifier: Apache-2.0
import { openSync, writeSync, closeSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HOME, readText } from "../util/fs.ts";
import { S, say } from "../state.ts";
import { H } from "../hooks.ts";
import { C, HL } from "../ui/theme.ts";

// every field of C and HL (HL.text → code); values are "r;g;b" or official-palette hex
interface Theme {
  name: string;
  text: string; sub: string; dim: string; line: string; sel: string; panel: string; accent: string; claude: string; codex: string; gemini: string; fx: string;
  green: string; yellow: string; red: string; cyan: string; purple: string; addBg: string; delBg: string; shadow: string;
  kw: string; str: string; num: string; com: string; fn: string; type: string; key: string; punct: string; flag: string; code: string;
}
const THEMES: Theme[] = [
  { name: "tokyo-night",
    text: "220;223;228", sub: "150;156;168", dim: "96;101;112", line: "58;62;72", sel: "40;44;54", panel: "22;24;30", accent: "122;162;247",
    claude: "217;119;87", codex: "110;180;255", gemini: "71;150;227", fx: "94;234;212", green: "126;211;135", yellow: "229;192;123", red: "240;113;120",
    cyan: "125;207;255", purple: "187;154;247", addBg: "22;48;32", delBg: "58;26;30", shadow: "8;8;10",
    kw: "187;154;247", str: "158;206;106", num: "255;158;100", com: "86;95;137", fn: "122;162;247", type: "42;195;222",
    key: "115;218;202", punct: "137;221;255", flag: "224;175;104", code: "192;202;245" },
  { name: "catppuccin-mocha",
    text: "cdd6f4", sub: "a6adc8", dim: "6c7086", line: "45475a", sel: "313244", panel: "181825", accent: "89b4fa",
    claude: "fab387", codex: "74c7ec", gemini: "89b4fa", fx: "94e2d5", green: "a6e3a1", yellow: "f9e2af", red: "f38ba8",
    cyan: "89dceb", purple: "cba6f7", addBg: "343e40", delBg: "402f42", shadow: "11111b",
    kw: "cba6f7", str: "a6e3a1", num: "fab387", com: "7f849c", fn: "89b4fa", type: "f9e2af",
    key: "b4befe", punct: "9399b2", flag: "f2cdcd", code: "cdd6f4" },
  { name: "gruvbox-dark",
    text: "ebdbb2", sub: "bdae93", dim: "928374", line: "504945", sel: "3c3836", panel: "1d2021", accent: "83a598",
    claude: "fe8019", codex: "83a598", gemini: "458588", fx: "8ec07c", green: "b8bb26", yellow: "fabd2f", red: "fb4934",
    cyan: "8ec07c", purple: "d3869b", addBg: "3f4028", delBg: "4a2d2a", shadow: "1d2021",
    kw: "fb4934", str: "b8bb26", num: "d3869b", com: "928374", fn: "8ec07c", type: "fabd2f",
    key: "83a598", punct: "a89984", flag: "fe8019", code: "ebdbb2" },
  { name: "nord",
    text: "eceff4", sub: "d8dee9", dim: "616e88", line: "4c566a", sel: "434c5e", panel: "3b4252", accent: "88c0d0",
    claude: "d08770", codex: "81a1c1", gemini: "5e81ac", fx: "8fbcbb", green: "a3be8c", yellow: "ebcb8b", red: "bf616a",
    cyan: "88c0d0", purple: "b48ead", addBg: "414a4c", delBg: "453b47", shadow: "2e3440",
    kw: "81a1c1", str: "a3be8c", num: "b48ead", com: "616e88", fn: "88c0d0", type: "ebcb8b",
    key: "8fbcbb", punct: "d8dee9", flag: "d08770", code: "d8dee9" },
  { name: "dracula", // sub and line are blends (the palette has no mid grays)
    text: "f8f8f2", sub: "acb5cb", dim: "6272a4", line: "44475a", sel: "343746", panel: "21222c", accent: "bd93f9",
    claude: "ffb86c", codex: "8be9fd", gemini: "bd93f9", fx: "ff79c6", green: "50fa7b", yellow: "f1fa8c", red: "ff5555",
    cyan: "8be9fd", purple: "bd93f9", addBg: "2e4b41", delBg: "4a313b", shadow: "191a21",
    kw: "ff79c6", str: "f1fa8c", num: "bd93f9", com: "6272a4", fn: "50fa7b", type: "8be9fd",
    key: "8be9fd", punct: "f8f8f2", flag: "ffb86c", code: "f8f8f2" },
  { name: "catppuccin-latte", // light: dark text, surface tones for bars, full-strength accents
    text: "4c4f69", sub: "6c6f85", dim: "8c8fa1", line: "acb0be", sel: "ccd0da", panel: "e6e9ef", accent: "1e66f5",
    claude: "fe640b", codex: "209fb5", gemini: "1e66f5", fx: "179299", green: "40a02b", yellow: "df8e1d", red: "d20f39",
    cyan: "04a5e5", purple: "8839ef", addBg: "cce1cd", delBg: "eac8d3", shadow: "bcc0cc",
    kw: "8839ef", str: "40a02b", num: "fe640b", com: "8c8fa1", fn: "1e66f5", type: "df8e1d",
    key: "179299", punct: "7c7f93", flag: "e64553", code: "4c4f69" },
];
const FILE = join(HOME, ".agentglass", "theme");
let cur = 0;

function rgb(v: string): string {
  if (v.indexOf(";") >= 0) return v;
  return parseInt(v.slice(0, 2), 16) + ";" + parseInt(v.slice(2, 4), 16) + ";" + parseInt(v.slice(4, 6), 16);
}
function find(name: string): number {
  for (let i = 0; i < THEMES.length; i++) if (THEMES[i].name === name) return i;
  return -1;
}
function apply(i: number): void {
  cur = i;
  const t = THEMES[i];
  C.text = rgb(t.text); C.sub = rgb(t.sub); C.dim = rgb(t.dim); C.line = rgb(t.line); C.sel = rgb(t.sel); C.panel = rgb(t.panel);
  C.accent = rgb(t.accent); C.claude = rgb(t.claude); C.codex = rgb(t.codex); C.gemini = rgb(t.gemini); C.fx = rgb(t.fx); C.green = rgb(t.green);
  C.yellow = rgb(t.yellow); C.red = rgb(t.red); C.cyan = rgb(t.cyan); C.purple = rgb(t.purple);
  C.addBg = rgb(t.addBg); C.delBg = rgb(t.delBg); C.shadow = rgb(t.shadow);
  HL.kw = rgb(t.kw); HL.str = rgb(t.str); HL.num = rgb(t.num); HL.com = rgb(t.com); HL.fn = rgb(t.fn); HL.type = rgb(t.type);
  HL.key = rgb(t.key); HL.punct = rgb(t.punct); HL.flag = rgb(t.flag); HL.text = rgb(t.code);
}
function save(name: string): void {
  try { mkdirSync(join(HOME, ".agentglass"), { recursive: true }); } catch (e) { /* exists */ }
  try { const fd = openSync(FILE, "w"); writeSync(fd, name + "\n"); closeSync(fd); } catch (e) { say("err", "cannot write " + FILE); }
}
function names(): string { return THEMES.map((t) => t.name).join(", "); }

// startup choice: env beats the persisted file; --theme (below) beats both
const env = process.env.AGENTGLASS_THEME;
const start = find(env !== undefined && env.trim() ? env.trim() : readText(FILE, 0, 64).trim());
if (start > 0) apply(start);

H.cli.push((args) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    let v = "";
    if (a === "--theme") v = args[i + 1] ?? "";
    else if (a.startsWith("--theme=")) v = a.slice(8);
    else continue;
    if (v === "list") { for (const t of THEMES) console.log((t.name === THEMES[cur].name ? "* " : "  ") + t.name); return true; }
    const n = find(v);
    if (n < 0) { console.error("unknown theme '" + v + "' — available: " + names()); process.exit(2); }
    apply(n);
  }
  return false;
});
H.keys.push((mode, k) => {
  if (k !== "T" || (mode !== "list" && mode !== "transcript" && mode !== "detail")) return false;
  apply((cur + 1) % THEMES.length);
  const name = THEMES[cur].name;
  save(name);
  if (S.dv) S.dv.lw = -1; // detail lines bake colors in: force a re-layout
  if (S.tv) S.tv.lw = -1;
  say("info", "theme: " + name);
  return true;
});
H.helpSections.push({ name: "themes", ctx: "", keys: [
  ["T", "cycle color theme (remembered)"], ["--theme <name>", "start with a theme (list: all)"],
  ["AGENTGLASS_THEME", "default theme via env"] ] });
