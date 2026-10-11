// the app's shared state: the socket, meta (version, redact, teams) through TanStack Query, the theme
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Meta } from "@agentglass/api-contract";
import { Live } from "./live/socket.ts";
export const LiveCtx = createContext<Live | null>(null);
export function useLive(): Live { const l = useContext(LiveCtx); if (!l) throw new Error("no Live"); return l; }
export function useStatus(): string { const l = useLive(); return useSyncExternalStore((f) => l.onStatus(f), () => l.status); }
export function useMeta(): Meta | undefined { const l = useLive(); return useQuery({ queryKey: ["meta"], queryFn: () => l.request<Meta>("meta"), staleTime: 60_000 }).data; }
declare global { interface Window { agTheme?: { get(): string; set(v: string): void } } }
export function useTheme(): [string, (t: string) => void] {
  const [t, setT] = useState(() => window.agTheme?.get() ?? "system");
  return [t, (v: string) => { window.agTheme?.set(v); setT(v); }];
}
// seconds since a time, re-rendered every second while shown
export function useNow(ms = 1000): number { const [n, setN] = useState(Date.now()); useEffect(() => { const i = setInterval(() => setN(Date.now()), ms); return () => clearInterval(i); }, [ms]); return n; }
export function ago(ms: number): string { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + "s" : s < 3600 ? Math.round(s / 60) + "m" : s < 86400 ? Math.round(s / 3600) + "h" : Math.round(s / 86400) + "d"; }
export function money(u: number | null | undefined): string { return u === null || u === undefined ? "—" : "$" + (u >= 100 ? u.toFixed(0) : u.toFixed(2)); }
