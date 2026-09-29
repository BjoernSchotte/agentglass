// agentglass — self-check for update target selection: sh scripts/check.sh
// SPDX-License-Identifier: Apache-2.0
import { relsFromJson, pickTarget, isDowngrade, sumFor } from "./update-core.ts";
let bad = 0;
function ok(w: string, c: boolean, g: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + g); } }
const ALL = ["agentglass-linux-x64.tar.gz", "agentglass-linux-arm64.tar.gz", "agentglass-darwin-x64.tar.gz", "agentglass-darwin-arm64.tar.gz", "SHA256SUMS", "build-metadata.json"];
function A(tag: string, pre: boolean, draft: boolean, assets: string[]): string {
  return "{\"tag_name\":\"" + tag + "\",\"prerelease\":" + pre + ",\"draft\":" + draft + ",\"assets\":[" + assets.map((n: string) => "{\"name\":\"" + n + "\"}").join(",") + "]}";
}
const rels = relsFromJson("[" + [
  A("dev-20261002.9.1-cccccccc", true, false, ALL.slice(1)), // newest dev, but no linux-x64 archive
  A("dev-20261001.8.2-bbbbbbbb", true, false, ALL),
  A("dev-20261001.8.1-aaaaaaaa", true, false, ALL),
  A("v2026.10.1", false, true, ALL),                          // draft
  A("v2026.9.10", false, false, ALL), A("v2026.9.9", false, false, ALL), A("nightly", true, false, ALL)].join(",") + "]");
function t(c: string, tag: string, plat: string): string { const r = pickTarget(rels, c, tag, plat); return r ? r.tag : ""; }
ok("parsed", rels.length === 7, String(rels.length));
ok("stable skips drafts, numeric order", t("stable", "", "linux-x64") === "v2026.9.10", t("stable", "", "linux-x64"));
ok("dev skips incomplete, attempt order", t("dev", "", "linux-x64") === "dev-20261001.8.2-bbbbbbbb", t("dev", "", "linux-x64"));
ok("dev incomplete ok for another platform", t("dev", "", "linux-arm64") === "dev-20261002.9.1-cccccccc", t("dev", "", "linux-arm64"));
ok("exact tag", t("stable", "v2026.9.9", "linux-x64") === "v2026.9.9", t("stable", "v2026.9.9", "linux-x64"));
ok("exact dev tag", t("stable", "dev-20261001.8.1-aaaaaaaa", "linux-x64") === "dev-20261001.8.1-aaaaaaaa", "");
ok("exact tag missing", t("stable", "v2026.1.1", "linux-x64") === "", "");
ok("exact tag that is a draft", t("stable", "v2026.10.1", "linux-x64") === "", "");
ok("garbage json", relsFromJson("{\"message\":\"API rate limit exceeded\"}").length === 0 && relsFromJson("not json").length === 0, "");
ok("downgrade dev→stable", isDowngrade("2026.9.10-dev.20261001.8+bbbbbbbb", "2026.9.10"), "");
ok("no downgrade stable→dev", !isDowngrade("2026.9.10", "2026.9.10-dev.20261001.8+bbbbbbbb"), "");
ok("no downgrade stable→newer stable", !isDowngrade("2026.9.9", "2026.9.10"), "");
ok("downgrade stable→older stable", isDowngrade("2026.9.10", "2026.9.9"), "");
ok("local never a downgrade", !isDowngrade("2026.9.10-local+abcdef12-dirty", "2026.9.9"), "");
ok("sumFor", sumFor("aa  agentglass-linux-x64.tar.gz\nbb *SHA256SUMS\n", "agentglass-linux-x64.tar.gz") === "aa" && sumFor("bb *x.tgz", "x.tgz") === "bb" && sumFor("", "x") === "", "");
console.log(bad ? bad + " failed" : "update: all checks passed");
process.exit(bad ? 1 : 0);
