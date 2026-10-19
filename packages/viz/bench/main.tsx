// the timeline bench page (W9.2 e2e): n synthetic spans (?n=50000) in the real component, for frame-time probes
import { createRoot } from "react-dom/client";
import "@agentglass/ui/tokens.css";
import { Timeline, synthetic } from "../src/index.ts";
const n = Number(new URLSearchParams(location.search).get("n") ?? "50000");
const spans = synthetic(n, 3);
const names = ["turn"].concat(Array.from({ length: 20 }, (_, i) => "Bash " + i));
createRoot(document.getElementById("root")!).render(<Timeline spans={spans} names={names} cats={["shell", "edit", "read", "web", "agent", "mcp", "other"]} kinds={["turn", "tool", "agent"]} maxHeight={300} />);
(window as unknown as { ready: boolean }).ready = true;
