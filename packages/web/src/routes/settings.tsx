import { Button } from "@agentglass/ui";
import { useMeta, useTheme } from "../app.tsx";
export function SettingsView() {
  const meta = useMeta(); const [theme, setTheme] = useTheme();
  const rows: [string, string][] = meta ? [["Version", meta.version], ["Contract", String(meta.contract)], ["Protocol", String(meta.proto)], ["Commands", meta.readOnly ? "read-only (this release shows, it does not act)" : "enabled"], ["Redacted", meta.redact ? "yes: names, paths and titles are fakes" : "no"], ["Harnesses", meta.harnesses.join(", ")], ["Teams", meta.teams.map((t) => t.name).join(", ") || "none"]] : [];
  return (
    <div className="max-w-2xl p-4">
      <h1 className="mb-4 text-[14px] font-semibold">Settings</h1>
      <section className="mb-6"><h2 className="mb-2 text-[11px] uppercase tracking-wide text-muted">Theme</h2>
        <div role="radiogroup" aria-label="Theme" className="flex gap-1">{["system", "dark", "light"].map((t) => <Button key={t} role="radio" aria-checked={theme === t} variant={theme === t ? "outline" : "ghost"} onClick={() => setTheme(t)}>{t}</Button>)}</div>
      </section>
      <section><h2 className="mb-2 text-[11px] uppercase tracking-wide text-muted">This agentglass</h2>
        <dl className="grid grid-cols-[9rem_1fr] gap-y-1.5">{rows.map(([k, v]) => <><dt key={k} className="text-muted">{k}</dt><dd key={k + "v"}>{v}</dd></>)}</dl>
        <p className="mt-4 text-muted">Configuration is edited in the TUI or ~/.agentglass/config.json; this page shows it.</p>
      </section>
    </div>
  );
}
