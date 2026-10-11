// the global key map: a key (with the previous key for g-sequences) → an action; typing in a field never triggers one
export type Action = "palette" | "help" | "filter" | "sidebar" | "down" | "up" | "open" | "back" | "fresh" | `go:${string}` | `nth:${number}` | "";
export function action(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; target?: unknown }, prev: string): Action {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") return "palette";
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return e.key === "Escape" ? "back" : "";
  if (e.metaKey || e.ctrlKey || e.altKey) return "";
  if (prev === "g") return ("go:" + e.key) as Action;
  switch (e.key) {
    case "?": return "help"; case "/": return "filter"; case "[": return "sidebar";
    case "j": case "ArrowDown": return "down"; case "k": case "ArrowUp": return "up";
    case "Enter": return "open"; case "Escape": return "back"; case ".": return "fresh";
  }
  if (/^[1-9]$/.test(e.key)) return ("nth:" + e.key) as Action;
  return "";
}
