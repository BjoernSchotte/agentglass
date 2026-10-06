// agentglass — self-check for the receive token store and random bytes: scriptc build src/features/hub/tokens.check.ts -o tc && ./tc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { HOME } from "../../util/fs.ts";
import { RAND, randomBytes, hex, b64url, ctEq } from "../../util/rand.ts";
import { addToken, rotateToken, revokeToken, checkToken, pinToken, readTokens, parseTokens, tokensText, tokStore, reloadTokens, tokenHash } from "./tokens.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function throws(f: () => void): string { try { f(); return ""; } catch (e) { return e instanceof Error ? e.message : String(e); } }

// random bytes, encodings, compare
const r1 = randomBytes(32); const r2 = randomBytes(32);
ok("32 bytes", r1.length === 32, String(r1.length));
ok("two reads differ", hex(r1) !== hex(r2), hex(r1));
ok("hex", hex(new Uint8Array([0, 15, 255])) === "000fff", hex(new Uint8Array([0, 15, 255])));
ok("b64url 32 → 43", b64url(r1).length === 43 && /^[A-Za-z0-9_-]+$/.test(b64url(r1)), b64url(r1));
ok("b64url vectors", b64url(new TextEncoder().encode("f")) === "Zg" && b64url(new TextEncoder().encode("fo")) === "Zm8" && b64url(new TextEncoder().encode("foo")) === "Zm9v" && b64url(new Uint8Array([251, 255])) === "-_8", b64url(new Uint8Array([251, 255])));
ok("ctEq", ctEq("abc", "abc") && !ctEq("abc", "abd") && !ctEq("abc", "abcd") && !ctEq("", "a"), "compare");
const d = join(HOME, "hubtok"); mkdirSync(d, { recursive: true, mode: 0o700 }); chmodSync(d, 0o700);
writeFileSync(join(d, "short"), "abc");
RAND.dev = join(d, "short");
ok("short device refused", throws(() => { randomBytes(32); }).indexOf("short read") >= 0, "no throw");
RAND.dev = "/dev/urandom";

// add: shown once, only the hash at rest
const f = join(d, "tokens"); const now = 1790000000000;
const t = addToken(f, "ci", 0, now, false);
ok("token shape", /^agr_[A-Za-z0-9_-]{43}$/.test(t), t);
const txt = readFileSync(f, "utf8");
let leak = false; for (let i = 4; i + 8 <= t.length; i++) if (txt.indexOf(t.slice(i, i + 8)) >= 0) leak = true;
ok("no part of the token at rest", !leak, txt);
ok("hash at rest", txt.indexOf(tokenHash(t)) >= 0, txt);
const mode = (p: string): string => { const o = execFileSync("stat", process.platform === "darwin" ? ["-f", "%Lp", p] : ["-c", "%a", p], { encoding: "utf8" }); return String(o).trim(); };
ok("file 0600", mode(f) === "600", mode(f));
let ts = readTokens(f).toks;
ok("accepted", checkToken(ts, t, now)?.name === "ci", "rejected");
const flip = t.slice(0, 10) + (t[10] === "A" ? "B" : "A") + t.slice(11);
ok("one char changed → rejected", checkToken(ts, flip, now) === null, "accepted");
ok("garbage rejected", checkToken(ts, "", now) === null && checkToken(ts, "Bearer " + t, now) === null && checkToken(ts, tokenHash(t), now) === null, "accepted");
ok("second add refused", throws(() => { addToken(f, "ci", 0, now, false); }).indexOf("rotate") >= 0, "no refusal");
ok("bad name refused", throws(() => { addToken(f, "../x", 0, now, false); }).indexOf("host name") >= 0, "no refusal");

// pin, repin
ok("pin", pinToken(f, tokenHash(t), "0011223344556677") === "", "write failed");
ts = readTokens(f).toks; ok("pinned", (checkToken(ts, t, now)?.pin ?? "") === "0011223344556677", JSON.stringify(ts));
ok("pin is first-only", pinToken(f, tokenHash(t), "8899aabbccddeeff") === "" && (readTokens(f).toks[0]?.pin ?? "") === "0011223344556677", "re-pinned");
ok("repin keeps the token", addToken(f, "ci", 0, now, true) === "" && checkToken(readTokens(f).toks, t, now)?.pin === "", "pin not cleared");
pinToken(f, tokenHash(t), "0011223344556677");
const tn = addToken(f, "nat", 0, now, false);
ok("a native host id (UUID) pins", pinToken(f, tokenHash(tn), "4c4c4544-0042-3510-8051-b4c04f4e3032") === "" && checkToken(readTokens(f).toks, tn, now)?.pin === "4c4c4544-0042-3510-8051-b4c04f4e3032", JSON.stringify(readTokens(f).toks));
ok("a host id with spaces or newlines does not", pinToken(f, tokenHash(tn), "a b") !== "" && pinToken(f, tokenHash(tn), "x\n- 1 2") !== "", "pinned");
revokeToken(f, "nat");
// rotated before the first request: whichever of the host's tokens pins first pins them all (one host directory, one id)
const tr = addToken(f, "rot", 0, now, false); const tr2 = rotateToken(f, "rot", 3600000, 0, now);
pinToken(f, tokenHash(tr), "0011223344556677");
ok("pin covers the host's other tokens", checkToken(readTokens(f).toks, tr2, now)?.pin === "0011223344556677", JSON.stringify(readTokens(f).toks));
revokeToken(f, "rot");

// rotate: both during grace, old fails after; the pin carries over
const t2 = rotateToken(f, "ci", 3600000, 0, now);
ts = readTokens(f).toks;
ok("rotate: old during grace", checkToken(ts, t, now + 3599000) !== null, "rejected");
ok("rotate: new during grace", checkToken(ts, t2, now + 3599000) !== null, "rejected");
ok("rotate: old after grace", checkToken(ts, t, now + 3600000) === null, "accepted");
ok("rotate: new after grace", checkToken(ts, t2, now + 3600000) !== null, "rejected");
ok("rotate keeps the pin", checkToken(ts, t2, now)?.pin === "0011223344556677", "pin lost");
ok("rotate unknown host", throws(() => { rotateToken(f, "nope", 1, 0, now); }).indexOf("no token") >= 0, "no refusal");

// expiry
const t3 = addToken(f, "lap", 7 * 86400000, now, false);
ts = readTokens(f).toks;
ok("expiry: before", checkToken(ts, t3, now + 7 * 86400000 - 1) !== null, "rejected");
ok("expiry: after", checkToken(ts, t3, now + 7 * 86400000) === null, "accepted");

// revoke: every token of the host at once, others untouched
ok("revoke count", revokeToken(f, "ci") === 2, "count");
ts = readTokens(f).toks;
ok("revoked", checkToken(ts, t, now) === null && checkToken(ts, t2, now) === null, "accepted");
ok("other host kept", checkToken(ts, t3, now) !== null, "lap lost");

// the store reloads on change (rename: new inode), refuses a non-private file (fail closed)
const st = tokStore(f);
ok("store loaded", checkToken(st.toks, t3, now) !== null && st.err === "", st.err);
const t4 = addToken(f, "ci", 0, now, false);
reloadTokens(st, 500, false); ok("throttled: not yet", checkToken(st.toks, t4, now) === null, "reloaded early");
reloadTokens(st, 1000, false); ok("reloaded within a second", checkToken(st.toks, t4, now) !== null, "not reloaded");
revokeToken(f, "ci"); reloadTokens(st, 2000, false); ok("revoke within a second", checkToken(st.toks, t4, now) === null, "still accepted");
chmodSync(f, 0o640);
reloadTokens(st, 3000, true);
ok("group-readable file refused", st.err.indexOf("chmod 600") >= 0 && st.toks.length === 0, st.err);
ok("readTokens refuses too", readTokens(f).err.indexOf("chmod 600") >= 0, readTokens(f).err);
ok("writes refused too", throws(() => { addToken(f, "x", 0, now, false); }).indexOf("chmod 600") >= 0, "written");
chmodSync(f, 0o600);
chmodSync(d, 0o750);
ok("open dir refused", readTokens(f).err.indexOf("chmod 700") >= 0, readTokens(f).err);
chmodSync(d, 0o700);

// parsing: malformed lines never count
const p = parseTokens("ci " + "a".repeat(64) + " 1 0 -\n# comment\nci " + "a".repeat(63) + " 1 0 -\nCI " + "b".repeat(64) + " 1 0 -\nok " + "c".repeat(64) + " 1 2 0011223344556677\n");
ok("parse", p.length === 2 && p[1]?.pin === "0011223344556677" && p[1]?.expires === 2, JSON.stringify(p));
ok("round trip", tokensText(parseTokens(tokensText(p))) === tokensText(p), tokensText(p));
if (bad) console.log(String(bad) + " failed"); else console.log("hub tokens: all checks passed");
if (bad) process.exit(1);
