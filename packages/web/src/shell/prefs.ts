// per-browser conveniences in localStorage, every access guarded (private windows, blocked storage)
export function load(key: string, dflt: string): string { try { return localStorage.getItem("agentglass." + key) ?? dflt; } catch { return dflt; } }
export function save(key: string, v: string): void { try { localStorage.setItem("agentglass." + key, v); } catch { /* not kept */ } }
