// the page's session: the one-time token from the URL fragment → POST /api/v1/session (the cookie is HttpOnly), the
// fragment removed from history at once; a reload asks GET /api/v1/session for the CSRF token of the cookie's session
export interface Boot { csrf: string; err: string }
export async function bootstrap(loc: Location = location, h: History = history, f: typeof fetch = fetch): Promise<Boot> {
  const m = /(?:^#|&)t=([A-Za-z0-9_-]+)/.exec(loc.hash);
  if (m) {
    h.replaceState(null, "", loc.pathname + loc.search); // the token never stays in history or reaches a Referer
    const r = await f("/api/v1/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: m[1] }) });
    if (r.ok) return { csrf: ((await r.json()) as { csrf: string }).csrf, err: "" };
  }
  const r = await f("/api/v1/session");
  if (r.ok) return { csrf: ((await r.json()) as { csrf: string }).csrf, err: "" };
  return { csrf: "", err: "This link was used or has expired. Run agentglass web again for a new one." };
}
// a new link pasted into a tab that is already open changes only the fragment: no reload, no request — the page must see
// it itself (else it keeps showing the old error or the old session). onToken: start over with the new token.
export function watchToken(onToken: () => void, w: Window = window): () => void {
  const on = () => { if (/(?:^#|&)t=[A-Za-z0-9_-]+/.test(w.location.hash)) onToken(); };
  w.addEventListener("hashchange", on); return () => w.removeEventListener("hashchange", on);
}
