import { Dialog, DialogContent, Kbd } from "@agentglass/ui";
import { SHORTCUTS } from "./shortcuts.ts";
export function Help({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Keyboard shortcuts" className="p-4">
        <h2 className="mb-3 text-[14px] font-semibold">Keyboard shortcuts</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {groups.map((g) => (
            <section key={g}><h3 className="mb-1 text-[11px] uppercase tracking-wide text-muted">{g}</h3>
              <ul>{SHORTCUTS.filter((s) => s.group === g).map((s) => <li key={s.keys} className="flex h-7 items-center justify-between gap-3"><span>{s.label}</span><Kbd>{s.keys}</Kbd></li>)}</ul>
            </section>))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
