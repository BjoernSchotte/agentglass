import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, Dialog, DialogContent, Kbd } from "@agentglass/ui";
import { shown } from "./shortcuts.ts";
export interface PaletteItem { id: string; label: string; group: string; keys?: string; run: () => void; disabled?: string }
// navigation, theme, open session, recent: the caller passes what applies (team sections only with a team, fleet only with hosts)
export function paletteItems(o: { go: (to: string) => void; theme: (t: string) => void; hasTeam: boolean; hasFleet: boolean; sessions: { key: string; title: string; harness: string }[]; open: (key: string) => void }): PaletteItem[] {
  const items: PaletteItem[] = [];
  shown(o.hasTeam, o.hasFleet).forEach((s, i) => items.push({ id: "go-" + s.id, label: "Go to " + s.label, group: "Navigation", keys: "g " + s.key + " · " + (i + 1), run: () => o.go(s.to) }));
  for (const t of ["system", "dark", "light"]) items.push({ id: "theme-" + t, label: "Theme: " + t, group: "Theme", run: () => o.theme(t) });
  for (const s of o.sessions.slice(0, 50)) items.push({ id: "open-" + s.key, label: "Open " + (s.title || s.key), group: "Sessions", keys: s.harness, run: () => o.open(s.key) });
  return items;
}
export function Palette({ open, onOpenChange, items }: { open: boolean; onOpenChange: (o: boolean) => void; items: PaletteItem[] }) {
  const groups = [...new Set(items.map((i) => i.group))];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Command palette" className="overflow-hidden">
        <Command label="Command palette" loop>
          <CommandInput placeholder="Type a command or search…" autoFocus />
          <CommandList>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            {groups.map((g) => (
              <CommandGroup key={g} heading={g}>
                {items.filter((i) => i.group === g).map((i) => (
                  <CommandItem key={i.id} value={i.label + " " + i.id} disabled={!!i.disabled} onSelect={() => { onOpenChange(false); i.run(); }}>
                    <span className="flex-1 truncate">{i.label}</span>{i.disabled ? <span className="text-muted">{i.disabled}</span> : i.keys ? <Kbd>{i.keys}</Kbd> : null}
                  </CommandItem>))}
              </CommandGroup>))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
