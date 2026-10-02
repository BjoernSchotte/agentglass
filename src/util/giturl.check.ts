// agentglass — self-check for the git remote scrub: scriptc build src/util/giturl.check.ts -o gc && ./gc
// SPDX-License-Identifier: Apache-2.0
import { scrubRemote, remoteLabel } from "./giturl.ts";
import { HOME } from "./fs.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }

const long = "https://host/" + "a".repeat(2040);
const T = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
// [input, url ("" = null), owner, name]
const rows: string[][] = [
  ["https://github.com/o/r.git", "https://github.com/o/r", "o", "r"],
  ["https://x-access-token:ghs_abc123@github.com/o/r.git", "https://github.com/o/r", "o", "r"],
  ["https://user:pass@gitlab.com/g/sub/r", "https://gitlab.com/g/sub/r", "sub", "r"],
  ["https://a:b@c@github.com/o/r", "https://github.com/o/r", "o", "r"],
  ["https://user%40corp:tok@host/o/r", "https://host/o/r", "o", "r"],
  ["https://host/o/r?token=abc", "https://host/o/r", "o", "r"],
  ["https://host/o/r#frag", "https://host/o/r", "o", "r"],
  ["https://host/o%40x/r", "", "", ""],
  ["https://host/o%3Ax/r", "", "", ""],
  ["https://ghp_" + T + "@host/o/r", "https://host/o/r", "o", "r"],
  ["https://host/o/r?access_token=glpat-xyz#oauth2", "https://host/o/r", "o", "r"],
  ["https://host/ghp_" + T + "/r", "https://host/ghp_" + T + "/r", "ghp_" + T, "r"],
  ["https://host/oauth2/r", "https://host/oauth2/r", "oauth2", "r"],
  ["https://host/o/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8", "https://host/o/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8", "o", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8"],
  ["git@github.com:o/r.git", "ssh://github.com/o/r", "o", "r"],
  ["ssh://git@host:2222/o/r.git", "ssh://host:2222/o/r", "o", "r"],
  ["git+ssh://git@host/o/r", "git+ssh://host/o/r", "o", "r"],
  ["git://host/o/r", "git://host/o/r", "o", "r"],
  ["HTTPS://GitHub.com/O/R", "https://github.com/O/R", "O", "R"],
  ["file://" + HOME + "/src/r", "file://~/src/r", "src", "r"],
  ["/srv/git/r.git", "file:///srv/git/r", "git", "r"],
  ["~/src/r", "file://~/src/r", "src", "r"],
  ["https://host", "https://host", "", ""],
  ["https://host/", "https://host", "", ""],
  [" https://host/o/r ", "https://host/o/r", "o", "r"],
  ["https://host/o/r\r\n", "https://host/o/r", "o", "r"],
  ["https://host/o\r/r\n", "", "", ""],
  ["https://host/o\tr", "", "", ""],
  [long, "", "", ""],
  ["", "", "", ""],
  ["not a url", "", "", ""],
  ["ftp://host/o/r", "", "", ""],
  ["https://host/o/my-repo-name-2026", "https://host/o/my-repo-name-2026", "o", "my-repo-name-2026"],
  ["https://user:pass@/o/r", "", "", ""],
  ["https://host:8443/o/r.git", "https://host:8443/o/r", "o", "r"],
  ["git@host:/abs/r", "", "", ""],
  ["C:\\src\\r", "", "", ""],
  ["user@host:o/r", "ssh://host/o/r", "o", "r"],
];
for (const r of rows) {
  const inp = r[0] ?? ""; const want = r[1] ?? "";
  const g = scrubRemote(inp);
  const w = JSON.stringify(inp);
  if (!want) { ok(w + " dropped", g === null, g ? g.url : "null"); continue; }
  ok(w + " url", !!g && g.url === want, g ? g.url : "null");
  ok(w + " owner/name", !!g && g.owner === (r[2] ?? "") && g.name === (r[3] ?? ""), g ? g.owner + "|" + g.name : "null");
  const all = g ? g.url + g.host + g.path + g.owner + g.name : "";
  for (const bad of ["ghs_", "pass", "tok", "token=", "corp", "frag"]) ok(w + " leaks " + bad, all.indexOf(bad) < 0, all);
}
const s = scrubRemote("git@github.com:o/r.git");
ok("label scp", !!s && remoteLabel(s) === "github.com/o/r", s ? remoteLabel(s) : "null");
const f = scrubRemote("/srv/git/r.git");
ok("label file", !!f && remoteLabel(f) === "/srv/git/r", f ? remoteLabel(f) : "null");
const h = scrubRemote("ssh://git@Host:2222/o/r");
ok("host lowercased, port kept", !!h && h.host === "host:2222" && h.path === "o/r", h ? h.host + " " + h.path : "null");
console.log(bad ? bad + " failed" : "giturl: all checks passed");
if (bad) process.exit(1);
