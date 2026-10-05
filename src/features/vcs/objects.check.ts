// agentglass — self-check for the object-DB lookup: scriptc build src/features/vcs/objects.check.ts -o oc && ./oc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../../util/fs.ts";
import { hasCommit, inIdx } from "./objects.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function bytes(h: string): number[] { const o: number[] = []; for (let i = 0; i + 1 < h.length; i += 2) o.push(parseInt(h.slice(i, i + 2), 16)); return o; }
function be(n: number): number[] { return [Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256]; }
// a version-2 .idx as git writes it: magic, version, fan-out, sorted names (CRCs and offsets after them don't matter here)
function idx(shas: string[]): Uint8Array {
  const s = shas.slice().sort(); const o: number[] = [0xff, 0x74, 0x4f, 0x63, 0, 0, 0, 2];
  for (let b = 0; b < 256; b++) { let n = 0; for (const x of s) if (parseInt(x.slice(0, 2), 16) <= b) n++; for (const v of be(n)) o.push(v); }
  for (const x of s) for (const v of bytes(x)) o.push(v);
  for (let i = 0; i < s.length * 8 + 40; i++) o.push(0);
  return new Uint8Array(o);
}
const D = join(HOME, "objects-check"); rmSync(D, { recursive: true, force: true });
const OBJ = join(D, "repo", ".git", "objects");
mkdirSync(join(OBJ, "pack"), { recursive: true }); mkdirSync(join(OBJ, "93"), { recursive: true });
const PACKED = ["00aa000000000000000000000000000000000001", "7360738aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "7360739bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "99c433a000000000000000000000000000000000", "ffee000000000000000000000000000000000000"];
writeFileSync(join(OBJ, "pack", "pack-1.idx"), idx(PACKED));
writeFileSync(join(OBJ, "93", "18fc4afa042fc26fcfbe494aeec3d4dfd4965f"), "x"); // a loose object
const C = join(D, "repo", ".git");
eq("loose", String(hasCommit(C, "9318fc4")), "1");
eq("packed first", String(hasCommit(C, "00aa000")), "1");
eq("packed middle (neighbours share a prefix)", String(hasCommit(C, "7360739")) + String(hasCommit(C, "7360738")), "11");
eq("packed last", String(hasCommit(C, "ffee000")), "1");
eq("full sha", String(hasCommit(C, "99c433a000000000000000000000000000000000")), "1");
eq("absent", String(hasCommit(C, "863a13f")) + String(hasCommit(C, "736073a")) + String(hasCommit(C, "fffffff")), "000");
eq("not a sha", String(hasCommit(C, "main")), "-1");
eq("no repo", String(hasCommit(join(D, "none", ".git"), "9318fc4")), "-1");
// an index git no longer writes (v1, no magic): cannot tell, never "absent"
writeFileSync(join(OBJ, "pack", "pack-0.idx"), new Uint8Array(2048));
eq("v1 index", String(inIdx(join(OBJ, "pack", "pack-0.idx"), "abcdef0")), "-1");
eq("unreadable pack makes absent unknown", String(hasCommit(C, "abcdef0")), "-1");
eq("found despite an unreadable pack", String(hasCommit(C, "99c433a")), "1");
// alternates: objects shared from another clone
const ALT = join(D, "base", "objects"); mkdirSync(join(ALT, "d3"), { recursive: true }); writeFileSync(join(ALT, "d3", "56c32aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), "x");
const O2 = join(D, "clone", ".git", "objects"); mkdirSync(join(O2, "info"), { recursive: true }); writeFileSync(join(O2, "info", "alternates"), ALT + "\n");
eq("alternates", String(hasCommit(join(D, "clone", ".git"), "d356c32")), "1");
eq("alternates absent", String(hasCommit(join(D, "clone", ".git"), "d356c33")), "0");
rmSync(D, { recursive: true, force: true });
if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("objects: all checks passed");
