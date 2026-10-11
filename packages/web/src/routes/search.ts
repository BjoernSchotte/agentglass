// the pages' URL search: types, the allowed values and the validators — in the shell (the router needs them before a
// page's lazy chunk loads); the pages import their lists from here

// stats
export interface StatsSearch { p?: string; f?: string; model?: string; sort?: string; proj?: string; from?: string; to?: string }
export const STATS_PERIODS: [string, string, string][] = [["d", "today", "today"], ["w", "7 days", "7d"], ["m", "this month", ""]];
export function validateStats(s: Record<string, unknown>): StatsSearch {
  const o: StatsSearch = {}; if (typeof s.p === "string" && STATS_PERIODS.some(([k]) => k === s.p)) o.p = s.p; if (typeof s.f === "string" && s.f) o.f = s.f;
  if (typeof s.model === "string" && s.model) o.model = s.model; if (s.sort === "cache") o.sort = "cache"; if (typeof s.proj === "string") o.proj = s.proj;
  const day = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v); // a brushed range of days (both or none)
  if (day(s.from) && day(s.to) && s.from <= s.to) { o.from = s.from; o.to = s.to; }
  return o;
}

// wait
export interface WaitSearch { p?: string; by?: string; f?: string }
export const WAIT_PERIODS: [string, string, string][] = [["d", "today", "today"], ["w", "7 days", "7d"], ["m", "30 days", "30d"]];
export const WAIT_BYS: [string, string][] = [["family", "command"], ["kind", "kind"], ["tool", "tool"]];
export function validateWait(s: Record<string, unknown>): WaitSearch {
  const o: WaitSearch = {};
  if (typeof s.p === "string" && WAIT_PERIODS.some(([k]) => k === s.p)) o.p = s.p;
  if (typeof s.by === "string" && WAIT_BYS.some(([k]) => k === s.by)) o.by = s.by;
  if (typeof s.f === "string" && s.f) o.f = s.f;
  return o;
}

// repos
export interface ReposSearch { p?: string; f?: string; sel?: string }
export const REPOS_PERIODS: [string, string, number][] = [["d", "today", 1], ["w", "7 days", 7], ["m", "30 days", 30], ["a", "all", 0]];
export function validateRepos(s: Record<string, unknown>): ReposSearch {
  const o: ReposSearch = {};
  if (typeof s.p === "string" && REPOS_PERIODS.some(([k]) => k === s.p)) o.p = s.p;
  if (typeof s.f === "string" && s.f) o.f = s.f; if (typeof s.sel === "string" && s.sel) o.sel = s.sel;
  return o;
}

// skills
export interface SkillsSearch { p?: string; sort?: string; f?: string }
export const SKILLS_PERIODS: [string, string, string][] = [["d", "today", "today"], ["w", "7 days", "7d"], ["m", "30 days", "30d"], ["a", "all", "all"]];
export const SKILLS_SORTS = ["cost", "loads", "tail", "size", "share", "persess"];
export function validateSkills(s: Record<string, unknown>): SkillsSearch {
  const o: SkillsSearch = {};
  if (typeof s.p === "string" && SKILLS_PERIODS.some(([k]) => k === s.p)) o.p = s.p;
  if (typeof s.sort === "string" && SKILLS_SORTS.includes(s.sort)) o.sort = s.sort;
  if (typeof s.f === "string" && s.f) o.f = s.f;
  return o;
}
