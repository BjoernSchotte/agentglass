// agentglass — self-check for the opt-in Linux agentglass:// handler: the .desktop text and the terminal choice
// SPDX-License-Identifier: Apache-2.0
import { desktopFile, pickTerminal, execArg, dropDefault } from "./urlhandler.ts";

let bad = 0;
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ":\n got  " + JSON.stringify(got) + "\n want " + JSON.stringify(want)); } }
eq("desktop file", desktopFile("kitty", "/home/u/.local/bin/agentglass"),
  "[Desktop Entry]\nType=Application\nName=agentglass link\nComment=Open agentglass:// links in agentglass\nNoDisplay=true\nTerminal=false\nMimeType=x-scheme-handler/agentglass;\nExec=kitty -e /home/u/.local/bin/agentglass open %u\n");
eq("a path with a space is quoted", execArg("/opt/my apps/agentglass"), "\"/opt/my apps/agentglass\"");
eq("quote, backslash, $ and backtick escaped", execArg("/a\"b\\c$d`e f"), "\"/a\\\\\"b\\\\\\\\c\\\\$d\\\\`e f\"");
eq("% doubled", execArg("/a%b"), "/a%%b");
const all = (c: string): boolean => true; const none = (c: string): boolean => false;
const only = (x: string): ((c: string) => boolean) => (c: string): boolean => c === x;
eq("config wins", pickTerminal("wezterm", { TERMINAL: "kitty" }, all), "wezterm");
eq("then $TERMINAL", pickTerminal("", { TERMINAL: "kitty" }, all), "kitty");
eq("then x-terminal-emulator", pickTerminal("", {}, all), "x-terminal-emulator");
eq("a missing config terminal falls through", pickTerminal("nope", { TERMINAL: "kitty" }, only("kitty")), "kitty");
eq("none → \"\"", pickTerminal("wezterm", { TERMINAL: "kitty" }, none), "");
eq("uninstall drops only our default", dropDefault("[Default Applications]\nx-scheme-handler/agentglass=agentglass-open.desktop\nx-scheme-handler/http=firefox.desktop\n"), "[Default Applications]\nx-scheme-handler/http=firefox.desktop\n");
eq("another handler for the scheme stays", dropDefault("x-scheme-handler/agentglass=other.desktop\n"), "x-scheme-handler/agentglass=other.desktop\n");
console.log(bad ? bad + " failed" : "urlhandler: all checks passed");
process.exit(bad ? 1 : 0);
