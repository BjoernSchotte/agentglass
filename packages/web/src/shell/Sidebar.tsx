import { Link } from "@tanstack/react-router";
import { PanelLeftClose, PanelLeftOpen, List, Users, Settings, ChartColumn, BellRing, Hourglass } from "lucide-react";
import { Button, Kbd, cn } from "@agentglass/ui";
import { SECTIONS } from "./shortcuts.ts";
const ICON: Record<string, typeof List> = { sessions: List, stats: ChartColumn, wait: Hourglass, alerts: BellRing, team: Users, settings: Settings };
export function Sidebar({ collapsed, onToggle, hasTeam, teamName }: { collapsed: boolean; onToggle: () => void; hasTeam: boolean; teamName: string }) {
  const shown = SECTIONS.filter((s) => !s.team || hasTeam);
  return (
    <nav aria-label="Sections" className={cn("flex h-full flex-col border-r border-border-subtle bg-surface", collapsed ? "w-12" : "w-52")}>
      <div className="flex h-11 items-center gap-2 px-3 font-semibold">{collapsed ? "◈" : <>◈ agentglass{hasTeam && <span className="truncate text-muted font-normal">· {teamName}</span>}</>}</div>
      <ul className="flex-1 space-y-0.5 px-1.5">
        {shown.map((s, i) => { const I = ICON[s.id] ?? List; return (
          <li key={s.id}>
            <Link to={s.to} className="flex h-7 items-center gap-2 rounded px-2 text-muted hover:bg-surface-2 hover:text-text [&.active]:bg-surface-2 [&.active]:text-text" title={s.label}>
              <I size={15} aria-hidden />{!collapsed && <><span className="flex-1">{s.label}</span><Kbd>{i + 1}</Kbd></>}
            </Link>
          </li>); })}
      </ul>
      <Button className="m-1.5" onClick={onToggle} aria-label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}>
        {collapsed ? <PanelLeftOpen size={15} /> : <><PanelLeftClose size={15} /> collapse <Kbd>[</Kbd></>}
      </Button>
    </nav>
  );
}
