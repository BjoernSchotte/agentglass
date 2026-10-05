# Model Prices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every model agentglass sees can get a price from the TUI (`$` panel in Stats, palette) or the CLI
(`agentglass prices …`): user prices, aliases (estimates) and gateway-config prices, with visible sources, and a price
change re-prices the ledger in memory without re-reading any log.

**Architecture:** One resolver (`pricing.ts` `resolve(model, prov)`) with five layers: user price > user alias >
gateway config (per provider) > community > built-in. The ledger keeps table-priced tokens per (local hour, provider,
model) per day (`Day.tp`, each row with its booked cost); `reprice()` applies the difference between the booked and the
current cost to every aggregate (`cost`, `unk`, `um`, `cp`, `hc`, `mt`). `prices.json` is written by one atomic JSON
writer shared with `config.json`. Display code reads the source per model from the resolver and the alias-priced share
from `tp`.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build), no runtime deps. Checks are
standalone scriptc programs (`*.check.ts`), shell tests `scripts/*.test.sh`.

**Spec:** [spec.md](spec.md) — read it first, including "Decisions" (each with its why and cost if wrong) and "Open questions"; this plan argues from it.

**Round:** 2 (after 2026.10.4). No earlier plan must be merged first. Coordinate the ledger `VERSION` with
tui-footprint (Global Constraints).

## Parallelism

| wave | tasks | worktree / branch | may run in parallel |
|---|---|---|---|
| 0 | Task 0 | `../agentglass-model-prices` / `feat/model-prices` | — (coordinator) |
| A | Task 1, Task 2, Task 3 | one worktree each: `../agentglass-mp-resolver` / `feat/mp-resolver`, `../agentglass-mp-gateway` / `feat/mp-gateway`, `../agentglass-mp-writer` / `feat/mp-writer` | yes: disjoint files |
| B | Task 4 | `../agentglass-mp-ledger` / `feat/mp-ledger` (after A merged into `feat/model-prices`) | — |
| C | Task 5, Task 6, Task 7 | `../agentglass-mp-cli`, `../agentglass-mp-marks`, `../agentglass-mp-panel` | yes; Task 6 and Task 7 both touch `stats.ts` in different hunks (6: lines ~150/194/226 summary, 7: key/render/footer/help) and Task 5 and Task 7 each add one import line to `src/main.ts`: the second to merge rebases |
| D | Task 8 | `../agentglass-model-prices` | — |

Each wave-A/C branch starts from `feat/model-prices` and merges back into it (rebase-merge) after its checks pass;
`feat/model-prices` goes to `main` as one PR after Task 8.

## Global Constraints

- Build `./build.sh`; tests `sh scripts/check.sh` (all `src/**/*.check.ts` + `scripts/*.test.sh`). A task is done only
  when both pass. Single check: `scriptc build <f> -o /tmp/x && AGENTGLASS_NOTIFY=0 /tmp/x`. One build at a time on
  this machine; run heavy steps with `nice`.
- scriptc 0.1.7 limits: nominal typing (pass fields, not foreign interfaces); no `Record<string, RegExp>` (C backend,
  #54) — keep regexes as named consts; a zero-parameter arrow for an optional interface member is rejected (SC2003);
  SC1090 array-index quirks (return `m[i] + 0` / `numAt`, no `.map` callbacks that index, a function returning
  `xs[i] ?? ""` must not feed `S.inputText` — return `String(…)`); out-of-range array reads trap; no Unix sockets;
  no `openSync(path, flags, mode)` (use `chmodSync`); prefer `split/join` over `replace` in new code.
- Never read a secret into a kept structure: from pi `models.json` and OpenCode config only `providers/provider` →
  model ids → `cost` numbers are copied; `apiKey`, `headers`, `options`, `baseUrl` never.
- Measurements and manual runs only with isolation env (`AGENTGLASS_CACHE_DIR`, `AGENTGLASS_CONFIG`,
  `AGENTGLASS_PRICES`, `AGENTGLASS_RULES`, `AGENTGLASS_RUN_DIR`, `AGENTGLASS_PALETTE_FILE`, `AGENTGLASS_THEME_FILE`,
  `AGENTGLASS_OTLP_DIR` in a scratch dir) and `AGENTGLASS_AGENT=0` in tmux. Never write the user's real
  `~/.agentglass/*`.
- Old behavior is a contract: with no `prices.json`, no gateway `cost` blocks and the community list off,
  `agentglass --json --subagents --limit 400` before/after gives field-identical `tokens`, `costUsd`, `unpricedTokens`
  for every session (only added fields differ) and `agentglass cost --json` identical `byMode` and `unpriced`
  (`byModel` keys of Gemini tier entries may change from `<base>>200k` to the real id — expected, list them in the PR).
- Ledger `VERSION` (`src/features/usage/codec.ts:12`, 15 today) bumps **once**, in Task 4, to the next free number at
  implementation time. If tui-footprint lands first with a bump, take the next one and keep its fields; `Day.tp` stays
  out of the lazily decoded heavy text `hv`.
- `prices.json` shape stays backward compatible: existing `{"input","output","cacheRead","cacheWrite","cacheWrite1h"}`
  entries and `kiroCreditUsd` keep working unchanged.
- Source names exactly: `user`, `alias`, `gateway`, `community`, `built-in`, `harness`, `unpriced` (JSON, OTLP); TUI
  short forms `user`, `≈ <target>`, `gw <provider>`, `litellm`/`models.dev`, `built-in`, `harness`, `unpriced`.
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Aggregate consistency after re-pricing**: unpriced → priced → re-priced → unpriced must leave `a.cost`, `a.unk`,
   `d.cost`, `d.unk`, `d.um`, `d.cp`, `d.hc`, `d.mt` equal (±1e-9) to an Acc booked from scratch under the final table.
   Harness-reported costs (pi/OpenCode `usageExact` with usd > 0, fx `total_cost`) never change. Task 4 check.
2. **Precedence**: a user price beats an alias of the same id; a gateway price applies only to its provider's bookings;
   aliases do not chain; an alias to an unpriced target leaves the model unpriced (never $0). Task 1 check.
3. **File safety**: invalid `prices.json` is never overwritten; a symlink stays a symlink; unrelated keys survive;
   `AGENTGLASS_PRICES` is honoured everywhere and unset in `scripts/check.sh`. Task 3 check + Task 5 shell test.
4. **Gemini parity**: every built-in Gemini row and the `-preview` / `-image` / tier cases cost the same before and after
   the move of the variant and tier rules into the resolver. Task 1 + Task 4 checks.
5. **No silent $0 and visible estimates**: a figure with alias-priced cost shows `≈` even in `api` mode; unpriced tokens
   stay in `unpricedTokens`/the unpriced line until a price exists. Task 6 checks.

---

### Task 0: Worktree, baseline, open question

**Files:** none committed.

- [ ] **Step 1:** `git worktree add -b feat/model-prices ../agentglass-model-prices origin/main && cd ../agentglass-model-prices && nice ./build.sh && sh scripts/check.sh`. Expected: build ok, all checks `ok`.
- [ ] **Step 2: Baseline** (isolated): `S=$(mktemp -d); E="AGENTGLASS_CACHE_DIR=$S/c AGENTGLASS_CONFIG=$S/config.json AGENTGLASS_PRICES=$S/prices.json AGENTGLASS_OFFLINE=1 AGENTGLASS_AGENT=0"; env $E nice ./agentglass --json --subagents --limit 400 > $S/before.json; env $E ./agentglass cost --json > $S/cost-before.json`. Keep `$S` outside the repo; Task 8 compares against it.
- [ ] **Step 3: Open question 1** (OpenCode `.json` vs `.jsonc` order): in `~`: `npx opensrc https://github.com/sst/opencode`, then `grep -rn "opencode.jsonc\|opencode.json" ~/opensrc/*opencode*/packages/opencode/src/config/*.ts | head`. Record the order in the PR description; Task 2 uses it. Fallback: `opencode.json`, then `opencode.jsonc`, then `config.json`.
- [ ] **Step 4: Gateway shapes** (keys only): `python3 -c "import json,os;o=json.load(open(os.path.expanduser('~/.pi/agent/models.json')));print({p:[sorted(m.get('cost',{}).keys()) for m in v.get('models',[])] for p,v in o.get('providers',{}).items()})"`. Expected: `{'cliproxy': [['cacheRead','cacheWrite','input','output']]}`. Task 2 fixtures copy the shape with fake numbers.

---

### Task 1: The resolver (wave A, parallel)

**Files:** Modify `src/features/usage/pricing.ts`; Modify `src/harness/gemini.ts:336-346` (only `priceKey`; the record
side of the Gemini change is Task 4); Test `src/features/usage/pricing.check.ts`.

**Interfaces — Produces** (`pricing.ts`):
```ts
export const PRICES_FILE: string; // process.env.AGENTGLASS_PRICES || join(HOME, ".agentglass", "prices.json")
export type PSrc = "user" | "alias" | "gateway" | "community" | "built-in";
export interface Resolved { p: Price; src: PSrc; key: string; via: string } // key = matched row; via = alias target | provider | community source
export function resolve(model: string, prov: string): Resolved | null;
export function price(model: string): Price | null;   // kept: resolve(model, "")?.p ?? null
export function loadUser(o: Obj | null): string[];    // replaces applyUserPrices; returns warnings (invalid entries)
export function readUserFile(path: string): { o: Obj | null; bad: string };
export function setGateway(g: Map<string, Price[]>): void; // provider → rows (Task 2 builds them)
export function setRemote(r: Remote | null): void;    // community list (now replaceable at runtime)
export function pricesSig(): string;                  // hash of user + gateway + community layers (replaces PRICES_SIG)
export function kiroRate(): number;                   // AGENTGLASS_KIRO_CREDIT_USD > 0, else prices.json kiroCreditUsd, else 0
export function pricesFrom(): string;                 // replaces PRICES_FROM: "built-in" | "litellm 2026-10-04"
export const PGEN: { n: number };                     // bumped on every layer change (memo + callers' caches)
```
- Layers kept as separate sorted arrays (`userP`, `userA` (alias rows `{p, target}`), `gw: Map<prov, Price[]>`,
  `comm`, `builtin`), each sorted longest key first. `resolve()`:
  1. `m = normModel(stripTiers(model))`, `tags` = the `@2027` / `>200k` suffixes found (in that order) on `model`.
  2. walk user prices → `{src:"user"}`; then aliases → resolve the target through user prices, gateway[prov],
     community, built-in (never aliases) → `{src:"alias", via: target}` or null when the target is unpriced; then
     `gw.get(prov)` (exact `id === m` match only); then community; then built-in.
  3. a row matches when `m.startsWith(row.p)` and, for `row.p` starting with `gemini-`, the rest is `""` or matches
     `GEMINI_SAME = /^-(preview|latest|exp|\d)/` (today's rule from `gemini.ts:340`).
  4. tiers: inside the matched layer, `k = row.p`; if `tags` has `@2027` and the layer has `k + "@2027"`, `k += "@2027"`;
     if `tags` has `>200k` and the layer has `k + ">200k"`, `k += ">200k"`; return that row.
  5. memo keyed `model + "\t" + prov`, cleared when `PGEN.n` changes.
- `loadUser` keeps today's rule (`pricing.ts:55`): a user price drops the built-in/community tier rows of its key that it
  does not name itself. An entry with `input` (number) is a price; with `alias` (non-empty string) and no `input` an
  alias; with both: price + warning `"<k>: has input and alias — using the price"`; anything else (except the numeric
  top-level `kiroCreditUsd`) → warning `"<k>: needs input+output or alias"`.
- `gemini.ts` `priceKey(md, input, iso)` becomes table-independent:
  `md + (iso >= "2027-01-01" ? "@2027" : "") + (input > 200000 ? ">200k" : "")`. The `?` marker is gone.

- [ ] **Step 1: Failing check** — extend `src/features/usage/pricing.check.ts` (keep the existing cases):

```ts
import { resolve, loadUser, setGateway, price, type Price } from "./pricing.ts";
const row = (p: string, i: number, o: number): Price => ({ p, i, o, cr: -1, cw: -1, cw1: -1 });
// before any user layer: today's results (parity)
const g31 = resolve("gemini-3.1-pro-preview", ""); ok("gemini preview → base", !!g31 && g31.key === "gemini-3.1-pro" && g31.src === "built-in", g31 ? g31.key : "null");
ok("gemini -image unpriced", resolve("gemini-3.1-pro-image", "") === null, "priced");
const t = resolve("gemini-3.1-pro-preview>200k", ""); ok("tier row", !!t && t.key === "gemini-3.1-pro>200k", t ? t.key : "null");
const t2 = resolve("gemini-3.5-flash>200k", ""); ok("no tier row → base", !!t2 && t2.key === "gemini-3.5-flash", t2 ? t2.key : "null");
const t3 = resolve("gemini-3.8-flash@2027", ""); ok("2027 row", !!t3 && t3.key === "gemini-3.8-flash@2027", t3 ? t3.key : "null");
ok("codex unpriced", resolve("gpt-6.1-sol", "") === null, "priced");
// layers
setGateway(new Map<string, Price[]>([["cliproxy", [row("claude-sonnet-5-5", 7, 70), row("gpt-6-sol", 1, 8)]]]));
const gw = resolve("claude-sonnet-5-5", "cliproxy"); ok("gateway for its provider", !!gw && gw.src === "gateway" && gw.p.i === 7 && gw.via === "cliproxy", gw ? gw.src : "null");
const bi = resolve("claude-sonnet-5-5", ""); ok("gateway not elsewhere", !bi || bi.src !== "gateway", bi ? bi.src : "null");
const w = loadUser(JSON.parse('{"gpt-6.1-sol":{"input":1.25,"output":10},"codex-auto-review":{"alias":"gpt-6.1-sol"},"x":{"alias":"codex-auto-review"},"y":{"alias":"nope-model"},"kiroCreditUsd":0.04,"bad":{"foo":1}}'));
ok("one warning (bad)", w.length === 1, w.join("|"));
const u = resolve("gpt-6.1-sol", ""); ok("user price", !!u && u.src === "user" && u.p.o === 10, u ? u.src : "null");
const a = resolve("codex-auto-review", ""); ok("alias", !!a && a.src === "alias" && a.via === "gpt-6.1-sol" && a.p.i === 1.25, a ? a.src : "null");
ok("alias does not chain", resolve("x", "") === null, "priced");
ok("alias to unpriced → unpriced", resolve("y", "") === null, "priced");
const ag = resolve("codex-auto-review", "cliproxy"); ok("user alias beats gateway", !!ag && ag.src === "alias", ag ? ag.src : "null");
loadUser(JSON.parse('{"gemini-3.1-pro":{"input":1,"output":2}}'));
const ut = resolve("gemini-3.1-pro-preview>200k", ""); ok("user price replaces tiers", !!ut && ut.src === "user" && ut.p.i === 1, ut ? ut.key : "null");
loadUser(null); setGateway(new Map<string, Price[]>());
ok("price() wrapper", price("claude-sonnet-4-5") !== null, "null");
```

- [ ] **Step 2: Run** `scriptc build src/features/usage/pricing.check.ts -o /tmp/pc && /tmp/pc`. Expected: build FAIL (`resolve` not exported).
- [ ] **Step 3: Implement** the interfaces above. Callers of the removed names: `PRICES_FROM` → `pricesFrom()` in
  `src/features/usage/stats.ts:150,730` and `src/features/prices.ts:26-33`; `PRICES_SIG` → `pricesSig()` in
  `src/features/usage/cache.ts:47,81`; `userRate("kiroCreditUsd")` → `kiroRate()` in `src/harness/kiro.ts:151`
  (`kiroRate()` reads the env first, as `creditUsd()` does today — drop `creditUsd()`). At import: `loadUser(readUserFile(PRICES_FILE).o)` and
  `setRemote(RC.source ? loadCached(RC.source) : null)`; warnings go through `say("warn", …)` once.
- [ ] **Step 4: Run** the check → `pricing: all checks passed`; `nice ./build.sh && sh scripts/check.sh` PASS
  (`gemini.check.ts` stays green: costs equal; if it asserts on booked keys, update those keys to the real id + tags and
  note it in the commit body).
- [ ] **Step 5: Commit** `feat(prices): layered price resolver with aliases and gateway layer`.

---

### Task 2: Gateway price reader (wave A, parallel)

**Files:** Create `src/features/usage/gwprices.ts`, `src/features/usage/gwprices.check.ts`; Modify
`src/features/usage/billing.ts:193` only to import the shared jsonc stripper (so `.jsonc` stops being skipped there).

**Interfaces — Produces:**
```ts
export function stripJsonc(text: string): string;                         // drops // and /* */ outside strings, trailing commas before } or ]
export function piRows(o: Obj | null): Map<string, Price[]>;              // providers.<p>.models[] {id, cost{input,output,cacheRead,cacheWrite}}
export function opencodeRows(o: Obj | null): Map<string, Price[]>;        // provider.<p>.models.<id>.cost {input,output,cache_read,cache_write,context_over_200k}
export function gatewayFiles(home: string, env: Map<string, string>): string[]; // pi models.json; OpenCode config candidates in Task 0 order
export function loadGateway(home: string, env: Map<string, string>): { rows: Map<string, Price[]>; sig: string }; // mtime-cached, ≤ every 60 s
```
- Row key `p` = `normModel(id)`; rates $/Mtok as stored; missing cache fields `-1`; `input`/`output` must be finite
  numbers ≥ 0 and < 10000, else the row is skipped. OpenCode `context_over_200k` → a second row `p + ">200k"`.
- pi and OpenCode rows merge into one map by provider key; same provider + id in both → pi wins (it is what pi
  sessions book; OpenCode providers rarely share pi's names) — document in a comment.
- Files read with `readText(…, 0, 2097152)`; parsed object dropped right after copying the numbers.

- [ ] **Step 1: Failing check** `gwprices.check.ts`: fixture JSON strings (fake numbers, with `"apiKey":"SECRET-1"` and
  `"headers":{"x":"SECRET-2"}`); assert rows (`cliproxy` → `claude-sonnet-5-5` 3/15/0.3/3.75), missing cache fields
  `-1`, a row without `output` skipped, jsonc with `// c`, `/* c */`, a `"//not-a-comment"` string value and a trailing
  comma parses, `context_over_200k` → `>200k` row, and `JSON.stringify` of every returned row contains no `SECRET`.
  `loadGateway` with a temp `home` (files written by the check) returns both harnesses' rows and a changed `sig` after a
  file changes.
- [ ] **Step 2: Run** `scriptc build src/features/usage/gwprices.check.ts -o /tmp/gw && /tmp/gw`. Expected: build FAIL.
- [ ] **Step 3: Implement**; switch `billing.ts` OpenCode config reading to `stripJsonc` for `.jsonc` files.
- [ ] **Step 4: Run** the check → `gwprices: all checks passed`; `sh scripts/check.sh` PASS (`billing.check.ts` green).
- [ ] **Step 5: Commit** `feat(prices): read per-model costs from pi and OpenCode configs`.

---

### Task 3: Atomic writer for `prices.json` (wave A, parallel)

**Files:** Modify `src/util/config.ts:42-64`; Create `src/features/usage/userprices.ts`,
`src/features/usage/userprices.check.ts`; Modify `scripts/check.sh` (add `-u AGENTGLASS_PRICES` to `run_check`'s
`env -u` list and to the shell tests' env).

**Interfaces — Produces:**
```ts
// config.ts
export function writeJsonAt(path: string, edit: (root: Obj) => void): void; // re-read, {} when missing/blank, throw when unreadable/not an object, symlink-through, tmp+rename, 0600
// writeConfigAt(path, name, key, value) becomes a thin wrapper over writeJsonAt (behavior unchanged; config.check.ts stays green)
// userprices.ts
export interface PriceIn { i: number; o: number; cr: number; cw: number; cw1: number } // -1 = not given
export function parsePriceLine(text: string): { p: PriceIn | null; err: string };      // "1.25 10 [0.125 [1.56 [2.5]]]"
export function checkPrice(p: PriceIn): string;                                        // "" ok, else reason
export function entryOf(p: PriceIn): Obj;                                               // {"input","output",["cacheRead","cacheWrite","cacheWrite1h"]}
export function storedKey(model: string): string;                                      // normModel(model)
export function setUserEntry(path: string, model: string, e: Obj | null): void;        // null = remove; throws on a bad file
export function userEntry(path: string, model: string): Obj | null;                    // current entry (for before/after and pre-fill)
```
- `parsePriceLine` errors, exactly: `"in and out are needed"`, `"\"<tok>\" is not a number"`, `"too many values (max 5)"`;
  `checkPrice`: `"prices must be ≥ 0"`, `"price over $10000/Mtok"`. Separators: spaces and/or `/` or `,`; `$` prefixes
  allowed (`$1.25 $10`).
- Alias validation lives with the resolver (Task 5/7 call `resolve(target, "")` and reject `src === "alias"` or null).

- [ ] **Step 1: Failing check** `userprices.check.ts` (temp dir under `/tmp/agentglass-up-<pid>`): write into a missing
  file → `{"gpt-x":{"input":1,"output":2}}`; existing `{"kiroCreditUsd":0.04,"a":{…}}` keeps both keys; remove with
  `null`; invalid JSON file → throws and the bytes are unchanged; symlink → the link stays a link and the target holds the
  change; `storedKey("openai/GPT-6.1-sol-20260101") === "gpt-6.1-sol"`; `parsePriceLine` cases above incl. `"$1.25 / $10"`
  and `"0 0"` (valid).
- [ ] **Step 2: Run** `scriptc build src/features/usage/userprices.check.ts -o /tmp/up && /tmp/up`. Expected: build FAIL.
- [ ] **Step 3: Implement**; refactor `writeConfigAt` onto `writeJsonAt`.
- [ ] **Step 4: Run** the check → `userprices: all checks passed`; `sh scripts/check.sh` PASS (`config.check.ts` green).
- [ ] **Step 5: Commit** `feat(prices): atomic prices.json writer and AGENTGLASS_PRICES`.

---

### Task 4: Ledger rows and in-place re-pricing (wave B)

**Depends on:** Tasks 1–3 merged into `feat/model-prices`.

**Files:** Modify `src/features/usage/record.ts:18-21,87-90,268-317` (Day, newDay, booking, Booking), `src/features/usage/codec.ts:12,66-82`,
`src/features/usage/cache.ts:15,47,81`, `src/harness/fx.ts:118`, `src/features/prices.ts` (live community apply);
Create `src/features/usage/repricer.ts`; Test `src/features/usage/record.check.ts`, `src/features/usage/codec.check.ts`.

**Interfaces — Produces:**
- `Day.tp: Map<string, number[]>` — key `"<hour>\t<prov>\t<model>"` (model = booked key incl. tier tags) →
  `[in, out, cacheRead, write5m, write1h, usd]`, `usd = -1` unpriced.
- `export function tableTok(a: Acc, d: Day, model: string, prov: string, nIn: number, nOut: number, nCr: number, w5: number, w1: number): void` —
  resolves, adds tokens to the row (`own()` new keys), books cost via `addCost` or tokens via `unpriced`, keeps the
  row's `usd` in step. `tokens()` = `count` + `modelTok` + `tableTok` (+ the book tap). Hot path: a per-Acc-free module
  cache of the last `(d, key) → row` avoids the string concat + map lookup when unchanged.
- `mkey()` strips a leading `?` and the `@2027` / `>200k` tags.
- `export function reprice(a: Acc): number` — the spec's algorithm (spec 3); returns the cost delta; snaps `|x| < 1e-9`
  to 0 in every touched aggregate; deletes `um` entries that reach 0.
- `Booking` gains `src: string` (a `PSrc`, `"harness"` for `usageExact` with usd > 0, `"unpriced"`) and `est: boolean`.
- `repricer.ts`: `export function repriceAll(): { usd: number; ms: number }` (every ledger Acc, then `L.ver++`,
  `L.idx++`); `export function reloadPrices(why: string): void` — re-read the user file (warnings → toast once per
  distinct text), gateway (`loadGateway`) and community cache (`loadCached`), apply via `loadUser/setGateway/setRemote`,
  and call `repriceAll()` only when `pricesSig()` changed. Registered on `H.onTick` with a 5 s throttle (mtime checks only;
  `stat` of ≤ 4 files). `src/features/prices.ts` calls `reloadPrices("community")` after a successful refresh and its
  message says `applied` instead of `applies on next start`.
- Cache: `VERSION` → next free (16 if free), comment line per the file's convention (`16: Day.tp per-hour priced-token rows
  (model-prices): caches load across price changes and re-price`). `dayOut/dayIn` gain `tp` (key `tp`, rows padded to 6).
  `cache.ts load()`: no longer returns on a price-signature mismatch; after loading, when the stored `prices` differs
  from `pricesSig()`, call `repriceAll()`; when the stored `kiro` (number) differs from `kiroRate()`, drop the Kiro
  sessions (`path` of a `kiro` harness session) from the loaded set so they re-index. `save()` writes `kiro: kiroRate()`.
- fx: `src/harness/fx.ts:118` calls `tableTok(a, d, md, "", inp, out, cr, cw, 0)` instead of `unpriced()` (count and
  `modelTok` already happened above it).

- [ ] **Step 1: Failing checks** appended to `record.check.ts`:

```ts
import { tokens, usageExact, reprice, newAcc, bucket } from "./record.ts";
import { loadUser } from "./pricing.ts";
function snap(a: Acc): string { // every aggregate a re-price touches, rounded
  const r = (x: number): string => (Math.round(x * 1e6) / 1e6).toFixed(6); const out: string[] = [r(a.cost), r(a.unk)];
  for (const [k, d] of a.days) { out.push(k, r(d.cost), r(d.unk)); for (const [m, n] of d.um) out.push("um " + m + " " + r(n)); for (const [p, c] of d.cp) out.push("cp " + p + " " + r(c));
    for (let h = 0; h < 24; h++) out.push(r(d.hc[h] ?? 0)); for (const [m, x] of d.mt) out.push("mt " + m + " " + x.map(r).join(",")); }
  return out.join("|");
}
function book(a: Acc): void {
  const d1 = bucket(a, 0, "2026-10-01T09:30:00.000Z"); tokens(a, d1, "gpt-6.1-sol", 1000, 200, 5000, 0, 0); tokens(a, d1, "claude-sonnet-4-5", 100, 10, 0, 50, 20);
  const d2 = bucket(a, 0, "2026-10-01T14:10:00.000Z"); tokens(a, d2, "codex-auto-review", 300, 30, 0, 0, 0, "");
  usageExact(a, d2, "claude-sonnet-5-5", 10, 10, 0, 0, 0, 0.5, "cliproxy"); tokens(a, d2, "claude-sonnet-5-5", 10, 10, 0, 0, 0, "cliproxy");
}
const tables = ['{}', '{"gpt-6.1-sol":{"input":1.25,"output":10}}', '{"gpt-6.1-sol":{"input":2,"output":8,"cacheRead":0.5},"codex-auto-review":{"alias":"gpt-6.1-sol"}}', '{}'];
loadUser(JSON.parse(tables[0] ?? "{}")); const live = newAcc(); book(live);
for (const t of tables) {
  loadUser(JSON.parse(t)); reprice(live);
  const fresh = newAcc(); book(fresh);
  ok("reprice == fresh under " + t, snap(live) === snap(fresh), snap(live) + "\n  vs " + snap(fresh));
}
// harness-reported 0.5 survives every table
let ex = 0; for (const d of live.days.values()) ex += d.cp.get("cliproxy") ?? 0; ok("harness cost kept", ex >= 0.5 - 1e-9, String(ex));
```
  And in `codec.check.ts`: `tp` round-trip through `accOut/accIn`; a ledger file written with `prices: "other"` loads
  (sessions present) and ends re-priced (cost equals a fresh booking); a stored `kiro: 0.01` with `kiroRate()` 0 drops the
  kiro session only. Timing check (own file `src/features/usage/reprice.check.ts`, first line `// check: timing`): 2000
  days × 3 rows, `reprice` under two alternating tables 10 times, each pass `< 20 ms`.
- [ ] **Step 2: Run** `scriptc build src/features/usage/record.check.ts -o /tmp/rc && /tmp/rc`. Expected: build FAIL (`reprice` missing).
- [ ] **Step 3: Implement** record/codec/cache/fx/repricer/prices changes.
- [ ] **Step 4: Run** the checks → `all checks passed`; `nice ./build.sh && sh scripts/check.sh` PASS.
- [ ] **Step 5: Measure** (isolated env from Task 0, community list off): cold index, then write
  `$S/prices.json` with `{"gpt-6.1-sol":{"input":1.25,"output":10}}` and run `cost --json` again: the second run loads the
  cache (no re-index: wall time < 3 s here vs 18 s cold) and `unpriced.byModel` lacks `gpt-6.1-sol`. Record both times in
  the PR.
- [ ] **Step 6: Commit** `feat(ledger): per-hour priced-token rows; price changes re-price in place`.

---

### Task 5: `agentglass prices` CLI (wave C, parallel)

**Depends on:** Task 4.

**Files:** Create `src/features/prices-cli.ts`, `scripts/prices.test.sh`; Modify `src/features/prices.ts` (help section
text; `prices update` routes to the `--update-prices` handler), `src/features/queries.ts:286-300` (`cost --by model`:
`priceSource`, `estimated` fields + text column `src`), `src/main.ts` (import after `./features/cost-cli.ts`),
`src/features/clihelp.ts` (examples: `agentglass prices --unpriced`, `agentglass prices set gpt-6.1-sol --in 1.25 --out 10`).

**Interfaces — Produces:** `export function priceRows(sinceKey: string, sc: Scope): Obj[]` (the JSON `models` array of
spec 6, sorted unpriced first by tokens, then cost desc) — Task 7's panel reuses it with the Stats period's days.
`addCmd` entries `prices`, `prices set`, `prices alias`, `prices unset`, `prices update` with `setOptions` records
(`--json`, `--since`, `--unpriced`; `--in`, `--out`, `--cache-read`, `--cache-write`, `--cache-write-1h`).

Behavior per spec 6: list runs `complete()` like `cost`; `set/alias/unset` do not load the ledger; output lines and JSON
exactly as the spec; exit codes 0 / 1 (`prices_file`) / 2 (`usage`) / 4 (`--unpriced` with rows). Alias errors:
`"<target> has no price — set one first (agentglass prices set <target> …)"`, `"aliases do not chain: <target> is an alias of <x>"`,
`"<model> cannot be an alias of itself"`. `set` with only `--in` → usage error `"--out is needed"`.
Harness-reported note (spec Decision 1): a row with `reportedCostUsd > 0` carries `note` =
`"cost reported by <harness label> — a user price applies only to its unpriced messages"` (JSON), an indented note line
in text output, and `set`/`alias` for such a model print the same note after the change line.

- [ ] **Step 1: Failing test** `scripts/prices.test.sh` (pattern of `scripts/cost.test.sh`: fake `HOME`, `AGENTGLASS_PRICES="$t/p/prices.json"`):
  one Codex rollout with `turn_context.model = "gpt-6.1-sol"` and a `token_count` event, one Claude session
  (`claude-sonnet-4-5`). Asserts: `prices --json | jq -r '.models[0].model, .models[0].source'` → `gpt-6.1-sol`,
  `unpriced`; `prices --unpriced` exit 4; `prices set gpt-6.1-sol --in 1.25 --out 10` exit 0 and the file has the entry;
  `prices --json` → source `user`, `costUsd` > 0, `prices --unpriced` exit 0; `prices alias gpt-6.1-sol-mini gpt-6.1-sol`
  then `prices alias x gpt-6.1-sol-mini` exit 2; `prices alias y nope` exit 2; `prices unset gpt-6.1-sol` exit 0 and
  `--unpriced` exit 4 again; invalid JSON in the file → `set` exit 1, file bytes unchanged (`cmp`); `AGENTGLASS_AGENT=1
  prices set z --in x --out 1` → stderr one JSON line with `.error.code == "usage"`, stdout empty;
  `cost --by model --json | jq -r '.[] | select(.model=="claude-sonnet-4-5") | .priceSource'` → `built-in`;
  a pi session fixture (`~/.pi/agent/sessions/--w--/<ts>_p1.jsonl`, assistant message with `usage.cost.total` 0.5,
  provider `cliproxy`, model `claude-sonnet-5-5`): `prices --json` row has `reportedCostUsd` 0.5 and a `note` starting
  `cost reported by pi`; `prices set claude-sonnet-5-5 --in 1 --out 1` prints that note.
- [ ] **Step 2: Run** `sh scripts/prices.test.sh`. Expected: FAIL (`unknown command prices`).
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** the test → no `FAIL`; `sh scripts/check.sh` PASS (`clihelp.check.ts` covers the new commands' help).
- [ ] **Step 5: Commit** `feat(cli): agentglass prices — list sources, set, alias, unset`.

---

### Task 6: Sources and estimates in figures, JSON and OTLP (wave C, parallel)

**Depends on:** Task 4.

**Files:** Modify `src/features/usage/costs.ts:20-51` (`ModeSum.est`, `addDay`, `money`), `src/features/usage/summary.ts:20-30`,
`src/features/usage/stats.ts:150,194,226,248` (subtitle counts, `≈$x by alias`, `· $ set prices` hint) and the session
preview `stats.ts:675-700`, `src/features/cli.ts:61,95-102,173` (`costEstimatedUsd`), `src/features/otlp/types.ts`,
`src/features/otlp/build.ts:237-240`, `src/features/otlp/encode.ts:57`; Tests `src/features/usage/costs.check.ts`,
`src/features/otlp/*.check.ts` (the encode check), `scripts/cost.test.sh`.

**Interfaces — Produces:**
- `ModeSum.est: number`; `addDay()` adds, for each `tp` row with `usd ≥ 0` whose `resolve(model, prov).src === "alias"`,
  `usd` to `est` (memo per `(model, prov)` keyed on `PGEN.n`).
- `money(c: number, bill: Bill | "", est = false)`: `≈` when `bill !== "api" || est`. `split()`/`moneyTag()` pass it
  through (`est = m.est > 0`).
- `export function sourceCounts(days: string[]): Map<PSrc, number>` (summary.ts) — models with usage per non-default
  source, for the Stats subtitle `prices: <pricesFrom()> · 2 user · 1 alias · 1 gw` (omit zero counts).
- Session `--json`: `costEstimatedUsd` (alias share, rounded like `costUsd`); help text in `cli.ts:95-102` lists it.
- OTLP: `XSpan` gains `src: string`, `est: boolean` (from `Booking`, last booking of the span wins; mixed → `"mixed"`);
  `encode.ts` adds `attrS("agentglass.usage.cost.source", …)` and `attrB("agentglass.usage.cost.estimated", …)` for
  chat spans; unpriced spans keep omitting the cost and get source `unpriced`.

- [ ] **Step 1: Failing checks**: `costs.check.ts` — `money(3, "api", true) === "≈$3.00"`, `money(3, "api") === "$3.00"`,
  `addDay` over a Day with an alias-priced `tp` row sets `est`; encode check — a span with `src "alias"` carries both
  attributes, an unpriced span has no `agentglass.usage.cost` and source `unpriced`; `scripts/cost.test.sh` — with
  `AGENTGLASS_PRICES` holding `{"gpt-x-unknown":{"alias":"claude-sonnet-4-5"}}`: `.[0].costEstimatedUsd > 0`,
  `.[0].unpricedTokens == 0`, and `cost` text shows `≈$` for the api session.
- [ ] **Step 2: Run** the three; Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS; `sh scripts/check.sh` PASS.
- [ ] **Step 5: Commit** `feat(costs): mark alias-priced figures and show price sources`.

---

### Task 7: Stats price panel and palette entries (wave C, parallel)

**Depends on:** Task 4 (and `priceRows` from Task 5: if Task 5 has not merged, implement the panel's row builder in
`pricepanel.ts` over `modelUses()` + `resolve()` and let Task 5 reuse it; whoever merges second deletes the duplicate).

**Files:** Create `src/features/usage/pricepanel.ts`, `src/features/usage/pricepanel.check.ts`; Modify
`src/features/usage/stats.ts:624-669` (key → panel when open; `$` opens), render branch (panel in place of the top-tools
list), footer `stats.ts:721-724` (`$ prices`), help `stats.ts:726-733` ("prices" block), `src/hooks.ts` (`dynActions`),
`src/features/palette/view.ts:108-109`, `src/main.ts` (import after `./features/usage/stats.ts`).

**Interfaces — Produces:**
- `pricepanel.ts`: `export const PP = { open: false, sel: 0 }`; `export function panelRows(days: string[]): PRow[]`
  (`{model, src, via, i, o, tok, cost, unk, est}`); `export function renderPanel(x, y, w, h, days)`; `export function
  panelKey(k: string, days: string[]): boolean`; `export function suggestAlias(model: string): string`.
- Input actions `price-set` and `price-alias` on `H.input`: `change` → validate (`parsePriceLine`/`checkPrice`, alias
  rules) and set `S.inputErr`; `enter` → invalid keeps the line open (return true); valid → `setUserEntry(PRICES_FILE, …)`,
  `reloadPrices("editor")`, toast per spec 5 (`history re-priced, <period> ±$x` from the period's cost before/after);
  write error → red toast, nothing changed. `tab` in `price-alias` completes priced model ids seen.
- Remove: `x` → `S.mode = "confirm"` with `remove the user price of <model>? (y/n)`; `y` → `setUserEntry(…, null)`.
- `H.dynActions: (() => Action[])[]` in `src/hooks.ts`; `palette/view.ts` appends `for (const f of H.dynActions) for (const a of f()) if (a.when(c)) out.push(actItem(a));`
  after the key-bound actions. pricepanel registers: "Prices: edit model prices" (keys `$`, when: Stats tab) and one
  "Set price for <model>" per unpriced model of the current Stats period (keys `$`, run: switch to Stats, open the panel
  with that model selected, open `price-set`).
- Layout per spec 5; at 80 columns `$IN`/`$OUT` drop first, then TOKENS; MODEL ≥ 18 columns; dead alias
  (`via` unpriced) red `≈ <target> (unpriced)`.

- [ ] **Step 1: Failing check** `pricepanel.check.ts` (fixture Accs via `src/features/query/fixture.ts` helpers, temp
  `AGENTGLASS_PRICES`): `panelRows` orders unpriced first; `renderPanel` at w=80 fits every line in 80 columns
  (`vwidth`) and keeps the full model id for ids ≤ 18 chars; `panelKey("enter")` opens input action `price-set` with
  `S.inputText` pre-filled `1.25 10` for a priced model and empty for an unpriced one; the `price-set` enter handler with
  `abc 1` keeps the line open with `S.inputErr` `"abc" is not a number`; with `1.25 10` writes the file, the model's row
  source becomes `user`, and its cost is > 0 in the next `panelRows`; `x` then `y` removes it; the dynamic palette action
  list contains `Set price for gpt-6.1-sol` while it is unpriced and not after; for a model with harness-reported cost
  the row tag is `harness`/`+harness`, the `price-set` input label contains `cost reported by` and so does the success
  toast (spec Decision 1).
- [ ] **Step 2: Run** `scriptc build src/features/usage/pricepanel.check.ts -o /tmp/pp && /tmp/pp`. Expected: build FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS; `nice ./build.sh && sh scripts/check.sh` PASS (`help.check.ts`, `footer.check.ts` green;
  the footer at 80 columns still fits — `footer.check.ts` asserts it).
- [ ] **Step 5: Manual** (tmux, isolated env, `AGENTGLASS_AGENT=0`, one TUI, killed after): `$` in Stats at 80, 120,
  200 columns; set a price, alias, remove; Ctrl+K → "Set price for …"; in a second shell `agentglass prices set …` →
  the TUI shows the change within 5 s. Screenshots (text captures via `tmux capture-pane -p`) into the PR.
- [ ] **Step 6: Commit** `feat(tui): Stats price panel ($) and palette price actions`.

---

### Task 8: Docs, contract check, PR (wave D)

**Files:** Modify `README.md` (costs section: price sources, precedence, `prices.json` shape incl. aliases, the `$`
panel, `agentglass prices`, `AGENTGLASS_PRICES`), `specs/ROADMAP.md` (status), `CHANGELOG.md` only if the repo's
release flow expects manual entries (check `git log -p -3 -- CHANGELOG.md`).

- [ ] **Step 1: Contract**: with the Task 0 isolated env and an empty `$S/prices.json`, run the two baseline commands
  again → `jq -S 'map({id,tokens,costUsd,unpricedTokens})'` of before/after identical; `cost --json` `byMode` and
  `unpriced.tokens` identical. Differences only in Gemini tier keys of `byModel` → list them in the PR.
- [ ] **Step 2:** `nice ./build.sh && sh scripts/check.sh` PASS.
- [ ] **Step 3: PR** `feat: model prices — editor, aliases, gateway prices, in-place re-pricing` from `feat/model-prices`
  to `main`; body: measurements (Task 4 Step 5), contract result, manual captures, decisions as recorded in the spec.

## Self-review against the spec
- Spec 1 → Task 1; 2 → Task 2; 3 → Task 4; 4 → Task 3 (+ wiring in 4/5/7); 5 → Task 7; 6 → Task 5; 7 → Task 4;
  8 → Task 6. Failure modes: invalid file (Tasks 3, 5), two writers (Task 7 Step 5), dead alias (Tasks 1, 7), drift
  (Task 4 check). Open question 1 → Task 0 Step 3.
