// hot reloading while working on the UI: agentglass-web from source on 127.0.0.1 (the real serve child, your data), Vite
// with HMR in front of it; /api and the WebSocket go through Vite's proxy with the BFF's own Host and Origin, so its checks
// stay as they are. Prints the one-time link on Vite's port.
//   pnpm --filter @agentglass/web dev [-- --host 0.0.0.0] [--agentglass <path>] [--redact]
// Changes under packages/web and packages/ui reload at once; a BFF change needs a restart of this script.
import { createServer } from "vite";

const argv = process.argv.slice(2); const val = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] ?? "" : ""; };
const bin = val("--agentglass") || process.env.AGENTGLASS_BIN || Bun.which("agentglass") || "";
if (!bin) { console.error("dev: no agentglass binary (--agentglass <path> or AGENTGLASS_BIN)"); process.exit(2); }
const host = val("--host") || "127.0.0.1"; const port = Number(val("--port") || "5173");
const bff = Bun.spawn(["bun", new URL("../../bff/src/main.ts", import.meta.url).pathname, "--agentglass", bin, ...(argv.includes("--redact") ? ["--redact"] : [])], { stdout: "pipe", stderr: "inherit" });
const first = new TextDecoder().decode((await bff.stdout.getReader().read()).value ?? new Uint8Array());
const { port: bport, url } = JSON.parse(first.split("\n")[0] || "{}") as { port: number; url: string };
if (!bport) { console.error("dev: agentglass-web did not start"); bff.kill(); process.exit(1); }
const target = "http://127.0.0.1:" + bport; const token = url.split("#t=")[1] ?? "";
const vite = await createServer({
  configFile: new URL("../vite.config.ts", import.meta.url).pathname,
  server: { host, port, strictPort: true, proxy: { "/api": { target, ws: true, changeOrigin: true,
    configure: (p) => { p.on("proxyReq", (r) => r.setHeader("origin", target)); p.on("proxyReqWs", (r) => r.setHeader("origin", target)); } } } },
});
await vite.listen();
const shown = host === "0.0.0.0" ? (Object.values((await import("node:os")).networkInterfaces()).flat().find((i) => i && !i.internal && i.family === "IPv4")?.address ?? "127.0.0.1") : host;
console.log("\n  agentglass web (dev, hot reload): http://" + shown + ":" + port + "/#t=" + token + "\n  the link works once, for 2 minutes · ctrl-c stops both\n");
const bye = () => { bff.kill(); void vite.close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 2000); }; // the BFF first: it holds the serve child
process.on("SIGINT", bye); process.on("SIGTERM", bye);
