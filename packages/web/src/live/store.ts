// a subscription's rows: a snapshot replaces them, a patch upserts and removes; newest first. While the reader is away
// from the top (frozen) rows that arrive are counted, not shown — live updates never move what the user reads.
import type { ApiEvent, SessionRow } from "@agentglass/api-contract";
export class Rows {
  rows = new Map<string, SessionRow>(); order: string[] = []; at = 0; ready = false;
  private shown: Set<string> | null = null; private ls = new Set<() => void>(); version = 0;
  apply(e: ApiEvent): void {
    const d = (e.d ?? {}) as { data?: SessionRow[]; upsert?: SessionRow[]; remove?: string[]; at?: number };
    if (e.k === "snapshot") { this.rows.clear(); for (const r of d.data ?? []) this.rows.set(String(r.key), r); this.ready = true; this.at = d.at ?? Date.now(); }
    else if (e.k === "patch") { for (const r of d.upsert ?? []) this.rows.set(String(r.key), r); for (const k of d.remove ?? []) this.rows.delete(k); this.at = Date.now(); }
    else return;
    this.order = [...this.rows.keys()].sort((a, b) => String(this.rows.get(b)!.updated).localeCompare(String(this.rows.get(a)!.updated)));
    this.emit();
  }
  freeze(on: boolean): void { this.shown = on ? new Set(this.visible()) : null; this.emit(); }
  get frozen(): boolean { return this.shown !== null; }
  visible(): string[] { const s = this.shown; return s ? this.order.filter((k) => s.has(k)) : this.order; }
  get fresh(): number { return this.order.length - this.visible().length; }
  subscribe = (f: () => void): (() => void) => { this.ls.add(f); return () => this.ls.delete(f); };
  snapshot = (): number => this.version;
  private emit(): void { this.version++; for (const f of this.ls) f(); }
}
