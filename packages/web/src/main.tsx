import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TipProvider } from "@agentglass/ui";
import { setNonce } from "get-nonce";
import "./index.css";
import { bootstrap, watchToken } from "./live/auth.ts";
import { Live } from "./live/socket.ts";
import { LiveCtx } from "./app.tsx";
import { makeRouter } from "./router.tsx";

// the per-response style nonce agentglass-web put into the page: Radix's injected <style> (scroll lock) carries it
const nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? "";
if (nonce && nonce !== "__CSP_NONCE__") setNonce(nonce);
const el = document.getElementById("root")!;
// a new one-time link pasted into this tab: start over with it (a reload runs the token exchange)
watchToken(() => location.reload());
void bootstrap().then((b) => {
  if (b.err) { el.innerHTML = ""; const p = document.createElement("p"); p.className = "p-6"; p.textContent = b.err; el.append(p); return; }
  const live = new Live(); live.connect();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
  createRoot(el).render(
    <StrictMode>
      <LiveCtx.Provider value={live}><QueryClientProvider client={qc}><TipProvider><RouterProvider router={makeRouter()} /></TipProvider></QueryClientProvider></LiveCtx.Provider>
    </StrictMode>,
  );
});
