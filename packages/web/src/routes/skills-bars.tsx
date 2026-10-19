// the Skills bars (W9.3): where each skill's tokens go — the load requests, the carry within the skill's own turn and
// the tail after it (tail is the part of carry past the turn) — stacked per skill in the table's order. Tokens, not $:
// measured for every skill, priced or not. Its own lazy chunk (ECharts).
import { useMemo } from "react";
import type { Skills } from "@agentglass/api-contract";
import { ChartFrame } from "@agentglass/viz";
import { Bars } from "@agentglass/viz/echarts";
import { tk, skillName } from "./skills.tsx";

const TOP = 15;
// per skill: load, carry within the turn, tail (≥ 0 each)
export function splitOf(r: { load: number; carry: number; tail: number }): [number, number, number] {
  const tail = Math.max(0, Math.min(r.tail, r.carry)); return [Math.max(0, r.load), Math.max(0, r.carry - tail), tail];
}

export function SkillBars({ d }: { d: Skills }) {
  const s = useMemo(() => {
    const rows = d.rows.slice(0, TOP); const parts = rows.map(splitOf);
    return { rows, parts, cats: rows.map((r) => skillName(r, d.hidden)), series: [
      { label: "load", values: parts.map((p) => p[0]), color: "accent" as const },
      { label: "carry in turn", values: parts.map((p) => p[1]), color: "live" as const },
      { label: "tail", values: parts.map((p) => p[2]), color: "attention" as const }] };
  }, [d]);
  if (!s.rows.length) return null;
  let L = 0; let C = 0; let T = 0; for (const p of s.parts) { L += p[0]; C += p[1]; T += p[2]; }
  const all = L + C + T;
  const pc = (x: number) => (all > 0 ? Math.round((x / all) * 100) : 0) + "%";
  const summary = s.rows.length + (d.rows.length > TOP ? " of " + d.rows.length : "") + " skills · " + tk(all) + " tokens · load " + pc(L) + " · carry in turn " + pc(C) + " · tail " + pc(T);
  const rows = s.rows.map((r, i) => ({ skill: s.cats[i], load: tk(s.parts[i]![0]), turn: tk(s.parts[i]![1]), tail: tk(s.parts[i]![2]) }));
  const cols = [{ key: "skill", label: "Skill" }, { key: "load", label: "Load", num: true }, { key: "turn", label: "Carry in turn", num: true }, { key: "tail", label: "Tail", num: true }];
  const h = 44 + 22 * s.cats.length;
  return (
    <ChartFrame title="Where skill tokens go" summary={summary} cols={cols} rows={rows} height={h}>
      <Bars cats={s.cats} series={s.series} fmt={tk} height={h} />
    </ChartFrame>
  );
}
