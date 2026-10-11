// every shortcut once: the key handler, the help dialog and the palette's key hints all read this list
export interface Shortcut { keys: string; label: string; group: "Navigation" | "List" | "View" }
export const SHORTCUTS: Shortcut[] = [
  { keys: "⌘K", label: "Command palette (Ctrl-K)", group: "View" },
  { keys: "?", label: "Keyboard shortcuts", group: "View" },
  { keys: "/", label: "Filter (the TUI's filter language)", group: "List" },
  { keys: "g s", label: "Go to Sessions", group: "Navigation" },
  { keys: "g c", label: "Go to Stats (costs)", group: "Navigation" },
  { keys: "g t", label: "Go to Team", group: "Navigation" },
  { keys: "g ,", label: "Go to Settings", group: "Navigation" },
  { keys: "1–9", label: "Go to the nth section", group: "Navigation" },
  { keys: "[", label: "Collapse or expand the sidebar", group: "View" },
  { keys: "j / k", label: "Next / previous row", group: "List" },
  { keys: "↵", label: "Open the row", group: "List" },
  { keys: "esc", label: "Close, back, clear the filter", group: "List" },
  { keys: ".", label: "Show new rows (the N new pill)", group: "List" },
];
export function hint(label: string): string { return SHORTCUTS.find((s) => s.label.startsWith(label))?.keys ?? ""; }
// sections: the sidebar, g-keys and 1–9; team ones only with a team
export interface Section { id: string; label: string; to: string; key: string; team?: boolean }
export const SECTIONS: Section[] = [
  { id: "sessions", label: "Sessions", to: "/sessions", key: "s" },
  { id: "stats", label: "Stats", to: "/stats", key: "c" },
  { id: "team", label: "Team", to: "/team", key: "t", team: true },
  { id: "settings", label: "Settings", to: "/settings", key: "," },
];
