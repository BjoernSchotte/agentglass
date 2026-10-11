// the shell (local-web-api §7): sidebar, top bar, the routed view, the status line; global keys; palette and help.
// List keys (j k ↵ / . esc) go to the active view as an "ag:key" event.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { Search, Keyboard, SunMoon } from "lucide-react";
import { Button, Kbd, Tip } from "@agentglass/ui";
import { Sidebar } from "./Sidebar.tsx";
import { Palette, paletteItems } from "./Palette.tsx";
import { Help } from "./Help.tsx";
import { action } from "./keys.ts";
import { SECTIONS } from "./shortcuts.ts";
import { load, save } from "./prefs.ts";
import { useLive, useMeta, useStatus, useTheme, useNow, ago } from "../app.tsx";
import { SESSIONS, ensureFeed } from "../routes/sessions.tsx";

export function emitKey(a: string): void { window.dispatchEvent(new CustomEvent("ag:key", { detail: a })); }
export function Layout() {
  const nav = useNavigate(); const meta = useMeta(); const status = useStatus(); const [theme, setTheme] = useTheme(); const now = useNow();
  const [collapsed, setCollapsed] = useState(() => load("sidebar", "open") === "collapsed");
  const [pal, setPal] = useState(false); const [help, setHelp] = useState(false);
  const prev = useRef("");
  const hasTeam = (meta?.teams.length ?? 0) > 0;
  useSyncExternalStore(SESSIONS.subscribe, SESSIONS.snapshot);
  const live0 = useLive(); useEffect(() => ensureFeed(live0), [live0]);
  const toggle = () => setCollapsed((c) => { save("sidebar", c ? "open" : "collapsed"); return !c; });
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (pal || help) return;
      const a = action(e, prev.current); prev.current = a === "" && e.key === "g" ? "g" : "";
      if (!a) return;
      const sections = SECTIONS.filter((s) => !s.team || hasTeam);
      if (a === "palette") setPal(true); else if (a === "help") setHelp(true); else if (a === "sidebar") toggle();
      else if (a.startsWith("go:")) { const s = sections.find((x) => x.key === a.slice(3)); if (s) void nav({ to: s.to }); else return; }
      else if (a.startsWith("nth:")) { const s = sections[Number(a.slice(4)) - 1]; if (s) void nav({ to: s.to }); else return; }
      else emitKey(a);
      e.preventDefault();
    };
    window.addEventListener("keydown", on); return () => window.removeEventListener("keydown", on);
  }, [pal, help, hasTeam, nav]);
  const live = SESSIONS.order.filter((k) => { const r = SESSIONS.rows.get(k); return r?.live; }).length;
  const items = paletteItems({ go: (to) => void nav({ to }), theme: setTheme, hasTeam, sessions: SESSIONS.order.map((k) => { const r = SESSIONS.rows.get(k)!; return { key: k, title: r.title, harness: r.harness }; }), open: (key) => void nav({ to: "/sessions", search: { sel: key } }) });
  return (
    <div className="flex h-screen">
      <Sidebar collapsed={collapsed} onToggle={toggle} hasTeam={hasTeam} teamName={meta?.teams[0]?.name ?? ""} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 items-center justify-end gap-1 border-b border-border-subtle px-3">
          {meta?.redact && <span className="mr-auto text-[12px] text-attention">redacted view</span>}
          <Tip label="Command palette"><Button size="sm" onClick={() => setPal(true)} aria-label="Command palette"><Search size={14} /><Kbd>⌘K</Kbd></Button></Tip>
          <Tip label={"Theme: " + theme}><Button size="icon" aria-label={"Theme: " + theme} onClick={() => setTheme(theme === "system" ? "dark" : theme === "dark" ? "light" : "system")}><SunMoon size={15} /></Button></Tip>
          <Tip label="Keyboard shortcuts"><Button size="icon" aria-label="Keyboard shortcuts" onClick={() => setHelp(true)}><Keyboard size={15} /></Button></Tip>
        </header>
        <main className="min-h-0 flex-1 overflow-auto"><Outlet /></main>
        <footer className="flex h-7 items-center gap-2 border-t border-border-subtle px-3 text-[12px] text-muted" aria-live="polite">
          <span className={status === "open" ? "text-live" : status === "ended" ? "text-error" : "text-attention"}>{status === "open" ? "● live" : status === "connecting" ? "◌ connecting" : status === "ended" ? "○ this tab's session ended — run agentglass web for a new link" : "○ reconnecting"}</span>
          {SESSIONS.ready && <span>· synced {ago(now - SESSIONS.at)} ago · {live} agent{live === 1 ? "" : "s"} running</span>}
          {meta && <span className="ml-auto">agentglass {meta.version}</span>}
        </footer>
      </div>
      <Palette open={pal} onOpenChange={setPal} items={items} />
      <Help open={help} onOpenChange={setHelp} />
    </div>
  );
}
