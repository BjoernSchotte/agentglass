// agentglass — colors (mutable palettes, so a theme can overwrite fields at runtime) and ANSI styling
// SPDX-License-Identifier: Apache-2.0
export const CSI = "\x1b[";
export const RST = CSI + "0m";
export function fg(c: string): string { return CSI + "38;2;" + c + "m"; }
export function bg(c: string): string { return CSI + "48;2;" + c + "m"; }
export const C = {
  text: "220;223;228", sub: "150;156;168", dim: "96;101;112", line: "58;62;72", sel: "40;44;54", panel: "22;24;30",
  accent: "122;162;247", claude: "217;119;87", codex: "110;180;255", fx: "94;234;212", green: "126;211;135", yellow: "229;192;123",
  red: "240;113;120", cyan: "125;207;255", purple: "187;154;247",
};
// syntax highlighting (shiki-ish, tokyo-night palette)
export const HL = {
  kw: "187;154;247", str: "158;206;106", num: "255;158;100", com: "86;95;137", fn: "122;162;247", type: "42;195;222",
  key: "115;218;202", punct: "137;221;255", flag: "224;175;104", text: "192;202;245",
};
export function lerp(a: string, b: string, t: number): string {
  const x = a.split(";"); const y = b.split(";");
  const r: string[] = [];
  for (let i = 0; i < 3; i++) r.push(String(Math.round(Number(x[i]) + (Number(y[i]) - Number(x[i])) * t)));
  return r.join(";");
}
export function heat(t: number): string { return t < 0.5 ? lerp(C.green, C.yellow, t * 2) : lerp(C.yellow, C.red, Math.min(1, (t - 0.5) * 2)); }
