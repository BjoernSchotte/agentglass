# Honest Costs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every dollar figure says what it is (spend / plan / cloud / gateway / unknown), unpriced usage is spelled out per model and in credits, Stats and `agentglass cost` project today and this month, and an optional monthly budget warns.

**Architecture:** Detection rules are pure functions over an evidence record (`src/features/usage/billing.ts`); a runtime module (`bill-live.ts`) gathers evidence from the transcript (stamped by adapters), the live process's environment names (Linux `/proc/<pid>/environ` through a new `Platform.envOf`) and config files, and resolves a mode per session and per provider. The ledger gains unit-clean unpriced fields, per-provider cost and per-hour cost; aggregation, money formatting, projection and budget logic are pure (`costs.ts`), summed over sessions by `summary.ts`, rendered by `stats.ts` and printed by a new `agentglass cost` command.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build), no runtime deps. Checks are standalone scriptc programs (`*.check.ts`), shell tests `scripts/*.test.sh`.

**Spec:** [spec.md](spec.md) — read it first, including "Decisions (review 2026-10-02)" and "Open questions"; this plan argues from it.

**Phase:** 1 (roadmap). No earlier plan must be merged first. Ships independently of parsing-fixes (phase 1); whichever of the two merges second rebases onto the other and keeps **one** `VERSION` bump if both land in the same release (Task 3, Step 1).

## Global Constraints

- Build `./build.sh`; tests `sh scripts/check.sh`; a task is done only when both pass. Single check: `scriptc build <f> -o /tmp/x && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/x`.
- scriptc 0.1.7 limits: no `readlinkSync`; no `n.toString(radix)` (use `String(n)`); nominal typing (pass fields, not foreign interfaces); call optional function members via a local; out-of-range array reads trap (`numAt`/bounds checks); a zero-parameter arrow for an optional interface member is rejected (SC2003); no `Promise.race` over mixed types; static builds lack `Math.sqrt`/`Math.log` (not needed here: means only).
- **No secret value is ever read into a kept structure**: environment values only for `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `GOOGLE_GENAI_USE_VERTEXAI` (reduced to on/off immediately); auth files parsed for type fields only; `~/.claude.json` for `oauthAccount.{billingType,seatTier,organizationType,claudeMaxTier}` and `cachedUsageUtilization` only — the parsed object is dropped right away. Nothing of this is logged, cached (except mode, plan name, source) or exported. Credentials never in argv/env of children/logs/`--json`.
- File reads size-capped (`readText(…, 0, 2097152)`), cached by mtime, re-checked at most every 60 s.
- macOS: no process-environment step (`ps -E` not used); Windows: none.
- Never write into agent data dirs. No network.
- Mode tags exactly: `api` → `spend`, `plan` → `plan`, `metered` → `cloud`, `gateway` → `gw`, `unknown` → `?`. Only `api` figures drop the `≈`.
- Budget config: `{ "budget": { "monthlyUsd": <number > 0>, "counts": [modes | "all"], "warnAt": 0 < x < 1 } }`, defaults `counts = ["api","metered","gateway"]`, `warnAt = 0.8`; invalid values ignored with one startup toast.
- `costUsd` in `--json` keeps its meaning (list-price figure, `null` when only unpriced usage exists).
- `src/features/usage/cache.ts` `VERSION` (`cache.ts:15`) bumps **once** in Task 3, to the next free number at implementation time. honest-costs and parsing-fixes share one bump when they ship in the same release (Task 3, Step 1).
- Old behavior is a contract for token totals and list-price cost: `agentglass --json --subagents --limit 400` before/after: `tokens` and `costUsd` field-identical for every session (only added fields differ), except fx sessions whose `costUsd` was `null` because of the old `1` marker (now unpriced tokens: still `null`).
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Worktree `../agentglass-honest-costs`, branch `feat/honest-costs`, PR to `main`, rebase-merge after green CI.

## Review Focus

1. **A secret value leaking into a kept structure** (environ `ANTHROPIC_API_KEY=sk-ant-SECRET`, auth.json key fields, `~/.claude.json` e-mail): nothing returned, stamped, cached or printed contains it. Task 4 check serializes every result and the env summary and asserts no `SECRET`/`@` substring; Task 3 cache round-trip check asserts the same for `accOut`.
2. **Precedence regressions**: a session stamped from transcript evidence (`metered` Bedrock id) must not flip to the current config's `plan`; a config-only session shows `src config` (assumed); a process-env result beats config; a later session-evidence result replaces a config or process stamp, never the reverse. Task 5 check.
3. **Unit mixing in "unpriced"**: Kiro credits never counted as tokens, fx $0 snapshot books tokens (not a `1` marker) under `fx:custom`, Gemini `?`-prefixed keys appear unprefixed in `um`; `s.cost = -1` only when cost is 0 and tokens or credits are unpriced. Task 2 check.
4. **Projection at the edges**: 2 days of history → `—` "not enough history"; the 1st of a month (month-to-date = today only); the current hour partly spent beyond its profile (contributes 0, not negative); a DST day (23 or 25 local hours) does not throw or double an hour. Task 7 check.
5. **Budget state and notification**: `monthlyUsd: "200"` (string) or `warnAt: 1.5` → ignored + one toast; `approx` iff a counted metered/gateway amount > 0; `over` notifies once per calendar day, not every tick; `AGENTGLASS_NOTIFY=0` suppresses `OS.notify` but not the toast. Task 8 check.

---

### Task 0: Worktree, open questions, fixture shapes

**Files:** none committed except a ledger note in the PR description; fixtures are hand-written lines inside checks (copies of real session/config data are never committed).

- [ ] **Step 1: Worktree + build**: `git worktree add -b feat/honest-costs ../agentglass-honest-costs main && cd ../agentglass-honest-costs && ./build.sh && sh scripts/check.sh`. Expected: build succeeds, all checks `ok`.
- [ ] **Step 2: Baseline** for the old-behavior contract: `./agentglass --json --subagents --limit 400 > /tmp/claude-1000/hc-before.json` (keep outside the repo).
- [ ] **Step 3: Open question 1 — fx auth storage.** Run: `ls -la ~/.fx; fx --help 2>&1 | head -40; strings "$(command -v fx)" 2>/dev/null | grep -iE 'auth\.json|api[_-]?key|credentials' | sort -u | head`. Expected evidence: a file path holding auth/provider type. Found → add an fx row to Task 4's rule table with the type field only. Not found (fallback, spec): fx stays `unknown`; note "fx: unknown, no documented auth storage" in the PR.
- [ ] **Step 4: Open question 2 — Codex `auth_mode` values.** Run in `~`: `npx opensrc https://github.com/openai/codex` then `grep -rn "enum AuthMode" -A8 ~/opensrc/*codex*/codex-rs | head -20; grep -rn 'rename_all\|serde(rename' ~/opensrc/*codex*/codex-rs/*/src/auth* | head`. Expected: the serialized literals (`chatgpt`, `apikey` or `api_key`, others). Record them; Task 4 maps `chatgpt` → plan, each API-key literal → api, any other value → `unknown`. Fallback if the source cannot be fetched: `chatgpt` → plan, any value containing `api` → api, else unknown.
- [ ] **Step 5: Open question 3 — pi `auth.json` type literal.** Run: `d=$(npm root -g)/@earendil-works/pi-coding-agent; grep -rnoE 'type: *"(oauth|api[_-]?key|apikey|key)"' "$d/dist" | sort -u | head`. Expected: the literal written for API keys. Task 4 maps `oauth` → plan and that literal → api. Fallback: `oauth` → plan, any other non-empty `type` → api.
- [ ] **Step 6: Provider fields for per-provider cost** (`cp`). Run: `grep -m1 -o '"provider":"[^"]*"' $(ls -t ~/.pi/agent/sessions/*/*.jsonl | head -1)`; for OpenCode 2.x `grep -n 'providerID' src/harness/opencode.ts src/harness/opencode-http.ts | head` and one row through the existing check fixtures in `src/harness/opencode.check.ts`. Expected: pi assistant `message.provider`; OpenCode 2.x `model.providerID`, 1.x step-finish row `providerID`. Record the exact paths; Task 2 Step 5 uses them. Fallback: provider `""` (whole session resolved with the session mode).
- [ ] **Step 7: Codex plan_type location.** Run: `grep -rhoE '"plan_type":"?[a-z_]*' ~/.codex/sessions | sort | uniq -c | head` and `grep -rho '"rate_limits":{.\{0,300\}' ~/.codex/sessions | grep plan_type | tail -1`. Expected: `plan_type` inside `payload.rate_limits` of `token_count` events. If it sits elsewhere, Task 5's codex stamp reads it from where it is; if absent everywhere, the codex auth.json rule still applies.
- [ ] **Step 8: Shapes for hand-written fixtures** (keys only, never values): `python3 -c "import json;c=json.load(open('$HOME/.claude.json'));print(sorted(c['oauthAccount'].keys()));print(json.dumps(c['cachedUsageUtilization'])[:200].replace(c['cachedUsageUtilization'].get('accountUuid',''),'U'))"`; `python3 -c "import json;print({k:v.get('type') for k,v in json.load(open('$HOME/.local/share/opencode/auth.json')).items()})"`; `python3 -c "import json;print(json.load(open('$HOME/.gemini/settings.json')).get('security',{}).get('auth',{}).get('selectedType'))"`. Expected today: `billingType stripe_subscription`, `seatTier team_tier_1`, `organizationType claude_team`; `cachedUsageUtilization{fetchedAtMs, utilization{five_hour{utilization 0–100, resets_at ISO}, seven_day{…}}}`; OpenCode `{anthropic: oauth}`; Gemini `gemini-api-key`. Task 4/9 fixtures copy these shapes with fake values.
- [ ] **Step 9:** If any real shape contradicts the spec's facts, write a `Ruling:` line in the PR description and follow the real data. No commit in this task.

---

### Task 1: Bedrock/Vertex model ids priced at list

**Files:** Modify `src/features/usage/pricing.ts:74-84` (`price()`); Create `src/features/usage/pricing.check.ts`.

**Interfaces — Produces:** `export function normModel(model: string): string` — lowercase, strip `provider/` prefix (last `/`), strip `[region.]anthropic.` prefix (`^(?:[a-z]{2,4}\.)?anthropic\.`), strip `arn:aws:bedrock:…/` (already covered by the last `/`), strip `-v\d+(:\d+)?$`, strip `@\d{8}$`, strip `-\d{8}$`. `price()` uses it; memo unchanged.

- [ ] **Step 1: Failing check** `src/features/usage/pricing.check.ts`:

```ts
import { price, normModel } from "./pricing.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const base = price("claude-sonnet-4-5");
ok("base priced", !!base, "null");
for (const id of ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", "anthropic.claude-sonnet-4-5-20250929-v1:0", "apac.anthropic.claude-sonnet-4-5-v2",
  "claude-sonnet-4-5@20250929", "arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0"]) {
  const p = price(id); ok("same row " + id, !!p && !!base && p.p === base.p, normModel(id));
}
ok("plain ids unchanged", normModel("gpt-5.1-codex") === "gpt-5.1-codex", normModel("gpt-5.1-codex"));
ok("unknown stays unknown", price("us.anthropic.nope-v1:0") === null, "priced");
console.log(bad ? bad + " failed" : "pricing: all checks passed");
if (bad) process.exit(1);
```

- [ ] **Step 2: Run** `scriptc build src/features/usage/pricing.check.ts -o /tmp/pc && /tmp/pc`. Expected: build FAIL (`normModel` not exported).
- [ ] **Step 3: Implement** `normModel` and call it in `price()` in place of the two inline normalisations (`pricing.ts:77-79`).
- [ ] **Step 4: Run** the check → `pricing: all checks passed`; `sh scripts/check.sh` PASS (the Gemini `priceKey` in `src/harness/gemini.ts:288-297` still slices by `p.p.length` after its own lowercase/`/` strip — gemini ids contain no Bedrock/Vertex parts, `gemini.check.ts` stays green).
- [ ] **Step 5: Commit** `feat(usage): price Bedrock and Vertex Claude ids at list price`.

---

### Task 2: Unit-clean unpriced, per-provider and per-hour cost in the ledger records

**Files:** Modify `src/features/usage/record.ts:8-18,35-38,41-48,102-113`, `src/harness/kiro.ts:176-177`, `src/harness/fx.ts:109-110`, `src/harness/pi.ts:146-153`, `src/harness/opencode.ts:329-334,366,374`, `src/features/usage/ledger.ts:57-61`, `src/model/types.ts:11,20-23` (Sess fields); Test `src/features/usage/record.check.ts`, `src/harness/kiro.check.ts`.

**Interfaces — Produces:**
- `Day` gains `um: Map<string, number>` (unpriced tokens per model, `?` prefix removed), `uc: number` (credits without a rate), `cp: Map<string, number>` (cost per provider key, `""` single-provider), `hc: number[]` (24, cost per local hour), `mt: Map<string, number[]>` (per-model day bucket: model → `[in, out, cacheRead, cacheWrite, costUsd]`, key = the model as booked with a leading `?` removed, `"unknown"` when empty; same key as `um`). `Day.unk` = unpriced **tokens only**. `mt` is the one per-model bucket: session-compare (models section) and cli-agent-mode (`cost --by model`, per-model session figures) read it through `modelUses`.
- `export function modelTok(d: Day, model: string, nIn: number, nOut: number, nCr: number, nCw: number): void` and the cost slot filled by `addCost(…, model)` — every booking path (`tokens()`, `usageExact()`, Kiro credits with a rate, fx priced deltas) adds to `mt[model]`.
- `export interface ModelUse { model: string; inTok: number; outTok: number; cr: number; cw: number; cost: number; unk: number /* unpriced tokens from um */ }`; `export function modelUses(a: Acc, days: string[] | null): ModelUse[]` — summed over the given local days (`null` = all), sorted by cost desc, then `inTok + outTok` desc, then model.
- `Acc` gains `uc: number`, `bill: string`, `plan: string`, `billSrc: string` (`""` = not stamped; `"session" | "process"`).
- `export function addCost(a: Acc, d: Day, usd: number, prov: string, model: string): void` — `a.cost`, `d.cost`, `d.cp[prov]`, `d.hc[tsHour]` (the hour of the last `bucket()` call), `d.mt[model][4]`.
- `export function unpriced(a: Acc, d: Day, model: string, n: number): void` — `a.unk`, `d.unk`, `d.um[model without leading "?" || "?"]`.
- `export function credits(a: Acc, d: Day, n: number): void` — `a.uc`, `d.uc`.
- `tokens(a, d, model, nIn, nOut, nCr, w5, w1, prov = "")`, `usageExact(…, usd, prov = "")` — book through `addCost`/`unpriced`.
- `Sess` gains `unkTok: number; unkCr: number; bill: string; plan: string; billSrc: string` (defaults `0, 0, "", "", ""`); `ledger.apply()` sets `s.unkTok = a.unk; s.unkCr = a.uc; s.cost = (a.unk > 0 || a.uc > 0) && a.cost === 0 ? -1 : a.cost` (bill fields are set in Task 5).

- [ ] **Step 1: Failing checks** appended to `src/features/usage/record.check.ts`:

```ts
import { tokens, usageExact, addCost, credits, modelUses } from "./record.ts";
const b = newAcc(); const iso2 = "2026-10-01T09:30:00.000Z"; const h2 = new Date(iso2).getHours();
const d2 = bucket(b, 0, iso2);
tokens(b, d2, "claude-sonnet-4-5", 1000, 100, 0, 0, 0);                 // priced
tokens(b, d2, "gpt-x-unknown", 900, 0, 0, 0, 0);                         // unpriced
tokens(b, d2, "?gemini-2.5-flash-lite", 300, 0, 0, 0, 0);                // gemini's unpriced marker key
usageExact(b, d2, "whatever", 10, 0, 0, 0, 0, 0.5, "openrouter");        // harness-reported cost, provider key
credits(b, d2, 120);
ok("unk tokens only", b.unk === 1200 && d2.unk === 1200, String(d2.unk));
ok("um per model", d2.um.get("gpt-x-unknown") === 900 && d2.um.get("gemini-2.5-flash-lite") === 300 && !d2.um.has("?gemini-2.5-flash-lite"), [...d2.um.keys()].join(","));
ok("credits apart", b.uc === 120 && d2.uc === 120 && b.unk === 1200, String(b.uc));
ok("cp per provider", (d2.cp.get("openrouter") ?? 0) === 0.5 && (d2.cp.get("") ?? 0) > 0, [...d2.cp.keys()].join(","));
let cps = 0; for (const v of d2.cp.values()) cps += v;
ok("cp sums to cost", Math.abs(cps - d2.cost) < 1e-9, cps + " vs " + d2.cost);
ok("hc hour", Math.abs((d2.hc[h2] ?? 0) - d2.cost) < 1e-9 && d2.hc.length === 24, (d2.hc[h2] ?? 0) + "");
const ms = d2.mt.get("claude-sonnet-4-5") ?? [];
ok("mt tokens", ms[0] === 1000 && ms[1] === 100 && (d2.mt.get("gpt-x-unknown") ?? [])[0] === 900 && d2.mt.has("gemini-2.5-flash-lite") && !d2.mt.has("?gemini-2.5-flash-lite"), [...d2.mt.keys()].join(","));
let mtc = 0; for (const v of d2.mt.values()) mtc += v[4] ?? 0;
ok("mt cost sums to cost", Math.abs(mtc - d2.cost) < 1e-9, mtc + " vs " + d2.cost);
const mu = modelUses(b, null);
ok("modelUses order + unk", mu.length === 4 && mu[0].cost >= mu[1].cost && (mu.filter((u) => u.model === "gpt-x-unknown")[0] ?? { unk: 0, cost: 1 }).unk === 900, mu.map((u) => u.model).join(","));
```

  In `src/harness/kiro.check.ts` add: a turn with `metering_usage [{unit:"credit",value:3}]` and no `kiroCreditUsd` → `a.uc === 3 && a.unk === 0`. In `record.check.ts` add an fx-style check through `fx.usageSidecar` on a temp `usage-v2.json` with `total_cost: 0` and `input_tokens: 500, output_tokens: 50` → `a.unk === 550`, `d.um.get("fx:custom") === 550` (or `a.model` when set), no `1` marker; a second snapshot with +100 input → `a.unk === 650`.
- [ ] **Step 2: Run** `scriptc build src/features/usage/record.check.ts -o /tmp/rc && /tmp/rc` → build FAIL (`addCost`/`credits` missing).
- [ ] **Step 3: Implement** in `record.ts` (fields in `newAcc` and the `bucket` day literal: `um: new Map<string, number>(), uc: 0, cp: new Map<string, number>(), hc: <24 zeros>, mt: new Map<string, number[]>()`), route `tokens`/`usageExact` through `modelTok` + `addCost`/`unpriced`; kiro: `if (rate > 0) addCost(a, d, cr * rate, "", a.model || "kiro") else if (cr > 0) credits(a, d, cr)`; fx: priced delta → `modelTok` + `addCost(a, d, c, "", a.model || "fx:custom")`, `total_cost === 0` with token delta → `unpriced(a, d, a.model || "fx:custom", inp + out + cr + cw)`; pi `book()` passes the assistant message's provider (Task 0 Step 6 field; new parameter `prov: string` on `book`, `""` for the usage/compaction/subagent-result paths); OpenCode `book()` likewise (`model.providerID` 2.x, row `providerID` 1.x).
- [ ] **Step 4: Run** record + kiro checks → PASS; `sh scripts/check.sh` PASS; `./build.sh && ./agentglass --json --subagents --limit 400 > /tmp/claude-1000/hc-t2.json` and compare `tokens`/`costUsd` per id with the Task 0 baseline: `jq -S '[.[]|{id,tokens,costUsd}]' /tmp/claude-1000/hc-before.json > /tmp/claude-1000/a.json; jq -S '[.[]|{id,tokens,costUsd}]' /tmp/claude-1000/hc-t2.json > /tmp/claude-1000/b.json; diff /tmp/claude-1000/a.json /tmp/claude-1000/b.json`. Expected: no diff except volatile/new sessions (ledger cache still on the old VERSION here — run with `HOME` untouched; the in-memory re-index gives the same numbers).
- [ ] **Step 5: Commit** `feat(usage): unpriced tokens per model, credits apart, cost per provider and hour`.

---

### Task 3: Ledger cache codec + version bump

**Files:** Create `src/features/usage/codec.ts` (moved from `cache.ts:20-72`: `num`, `nums`, `recsOut/In`, `cntsOut/In`, `at`, `padTo`, `dayOut/In`, `accOut/In`, plus `VERSION`); Modify `src/features/usage/cache.ts` (imports them, keeps IO); Create `src/features/usage/codec.check.ts`.

**Interfaces — Consumes:** Day/Acc fields from Task 2. **Produces:** `export const VERSION: number`; `export function accOut(a: Acc, keepIds: number): Obj`; `export function accIn(o: Obj): Acc`. New keys: day `um` (object model → n), `uc`, `cp` (object prov → usd), `hc` (24 numbers), `mt` (object model → 5 numbers); acc `uc` appended at index 9 of `t`, `bill`, `plan`, `bs`.

- [ ] **Step 1: Pick the number**: `git fetch && git show origin/main:src/features/usage/cache.ts | grep -n 'const VERSION'`. Use the next free number at implementation time (e.g. 5 → 6 if nothing else bumped). If parsing-fixes already bumped it and both ship in the same release, do not bump again (append this spec's reason to that comment). Comment: `// N: honest-costs — unk = unpriced tokens only, um/uc/cp/hc/mt per day, bill/plan/bs per session; …`.
- [ ] **Step 2: Failing check** `codec.check.ts`: build an Acc via Task 2 primitives (priced + unpriced + credits + provider + `a.bill = "metered"; a.plan = "team"; a.billSrc = "session"`), `const o = accOut(a, 64); const b = accIn(JSON.parse(JSON.stringify(o)))`; assert every Day field (`unk`, `um`, `uc`, `cp`, `hc[h]`, `mt`) and `b.uc/bill/plan/billSrc` equal; assert `accIn({...o, t: o.t.slice(0, 9)})` (an older 9-element `t`) gives `uc === 0`; assert `JSON.stringify(o)` has no key named `env`, `key`, `token`. Run → FAIL (module missing).
- [ ] **Step 3: Implement** the move + new keys; `cache.ts` `load()` keeps rejecting `v !== VERSION` (a file with the previous number is discarded and re-indexed).
- [ ] **Step 4: Run** codec check PASS; `sh scripts/check.sh` PASS. Manual: copy `~/.agentglass/cache/ledger.json` to the scratchpad, start `./agentglass` once → indexing gauge runs from 0 (re-index), quit, `jq '.v' ~/.agentglass/cache/ledger.json` = new VERSION; restore is not needed (the old file is replaced by design).
- [ ] **Step 5: Commit** `refactor(usage): ledger codec module; cache v<N> with billing and unpriced fields`.

---

### Task 4: Billing rules (pure) + config readers + environ summary

**Files:** Create `src/features/usage/billing.ts`, `src/features/usage/billing.check.ts`; Modify `src/platform/types.ts` (`envOf`), `src/platform/linux.ts`, `src/platform/darwin.ts`.

**Interfaces — Produces:**
- `export type Bill = "api" | "plan" | "metered" | "gateway" | "unknown"`; `export const MODES: Bill[] = ["api", "plan", "metered", "gateway", "unknown"]`; `export function tag(b: Bill): string` (`spend|plan|cloud|gw|?`).
- `export interface Det { bill: Bill; plan: string; why: string; src: string }` (`src` `"session" | "process" | "config" | ""`).
- `export interface Evid { names: string[]; on: string[]; kv: Map<string, string> }` — env names present, switches on, config facts. kv keys: `claude.helper` (`"1"`), `claude.billingType`, `claude.plan`, `codex.auth_mode`, `codex.provider`, `gemini.selectedType`, `auth.<provider>` (pi/OpenCode type literal).
- `export const SWITCHES = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "GOOGLE_GENAI_USE_VERTEXAI"]`.
- `export function envSummary(raw: Uint8Array): { names: string[]; on: string[] }` — split at byte 0, name = bytes before the first `=`; value decoded **only** for names in `SWITCHES`, on = value not in `"", "0", "false", "no", "off"` (case-insensitive); the decoded value is not stored.
- `export function rule(h: string, ev: Evid, src: string): Det` — the spec §2 table, first match wins; `unknown` with `src ""` when nothing matches. kiro → `plan` always; fx → `unknown` (or the Task 0 Step 3 rule).
- `export function provRule(h: string, prov: string, ev: Evid, src: string): Det` — pi/OpenCode per provider: `auth.<prov>` `oauth` → plan; pi API-key literal (Task 0 Step 5) / OpenCode `api` → api; OpenCode `wellknown` → gateway; env name `<PROV upper, - → _>_API_KEY` → api.
- `export function modelBill(model: string): Bill | ""` — Bedrock (`anthropic.claude-`, `^(us|eu|apac)\.anthropic\.`, `arn:aws:bedrock`) or Vertex (`claude-…@\d{8}`) → `"metered"`, else `""`.
- `export function configEv(h: string, home: string, cwd: string): Evid` — reads the harness's files under `home` (size-capped, try/catch, malformed → empty kv): claude `~/.claude/settings.json`, `<cwd>/.claude/settings.json`, `<cwd>/.claude/settings.local.json` (`apiKeyHelper` presence → `claude.helper`; `env` block names → `names`, switch values → `on`), `~/.claude.json` (`oauthAccount.billingType` → `claude.billingType`; plan = `claudeMaxTier || organizationType minus "claude_" || seatTier` → `claude.plan`; object dropped after); codex `~/.codex/auth.json` (`auth_mode`; `OPENAI_API_KEY` non-null → name `OPENAI_API_KEY` in `names`) and `~/.codex/config.toml` (line scan `^\s*model_provider\s*=\s*"([^"]+)"`); gemini `~/.gemini/settings.json` `security.auth.selectedType`; pi `~/.pi/agent/auth.json`, OpenCode `~/.local/share/opencode/auth.json` (`auth.<k>` = `type`).
- `export function planLabel(plan: string, redact: boolean): string` — `redact && !/^[a-z0-9_]+$/.test(plan) ? "plan" : plan`.
- `Platform.envOf(pid: number): Uint8Array` — linux: `readBytes("/proc/" + pid + "/environ", 0, 262144)` (empty on error); darwin: `new Uint8Array(0)`.

- [ ] **Step 1: Failing checks** `billing.check.ts` (temp home `/tmp/agentglass-billing-check/home`, written with `writeFileSync`, removed at the end):

```ts
const E = (names: string[], on: string[], kv: string[][]): Evid => { const m = new Map<string, string>(); for (const p of kv) m.set(p[0] ?? "", p[1] ?? ""); return { names, on, kv: m }; };
// claude precedence
ok("bedrock switch", rule("claude", E(["CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_API_KEY"], ["CLAUDE_CODE_USE_BEDROCK"], []), "process").bill === "metered", "");
ok("switch off = absent", rule("claude", E(["CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_API_KEY"], [], []), "process").bill === "api", "");
ok("auth token = gateway", rule("claude", E(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"], [], []), "process").bill === "gateway", "");
ok("helper = api", rule("claude", E([], [], [["claude.helper", "1"], ["claude.billingType", "stripe_subscription"]]), "config").bill === "api", "");
const pl = rule("claude", E([], [], [["claude.billingType", "stripe_subscription"], ["claude.plan", "team"]]), "config");
ok("subscription = plan team", pl.bill === "plan" && pl.plan === "team" && pl.src === "config", pl.bill + pl.plan);
ok("nothing = unknown", rule("claude", E([], [], []), "config").bill === "unknown", "");
// codex, gemini, kiro, opencode, pi
ok("codex chatgpt", rule("codex", E([], [], [["codex.auth_mode", "chatgpt"]]), "config").bill === "plan", "");
ok("codex apikey", rule("codex", E([], [], [["codex.auth_mode", "apikey"]]), "config").bill === "api", "");
ok("codex azure", rule("codex", E([], [], [["codex.provider", "azure"]]), "config").bill === "metered", "");
ok("codex other provider", rule("codex", E([], [], [["codex.provider", "litellm"]]), "config").bill === "gateway", "");
ok("gemini vertex switch", rule("gemini", E(["GEMINI_API_KEY"], ["GOOGLE_GENAI_USE_VERTEXAI"], []), "process").bill === "metered", "");
ok("gemini oauth", rule("gemini", E([], [], [["gemini.selectedType", "oauth-personal"]]), "config").bill === "plan", "");
ok("gemini key", rule("gemini", E([], [], [["gemini.selectedType", "gemini-api-key"]]), "config").bill === "api", "");
ok("kiro always plan", rule("kiro", E(["AWS_ACCESS_KEY_ID"], [], []), "config").bill === "plan", "");
ok("opencode wellknown", provRule("opencode", "corp", E([], [], [["auth.corp", "wellknown"]]), "config").bill === "gateway", "");
ok("pi env key", provRule("pi", "open-router", E(["OPEN_ROUTER_API_KEY"], [], []), "process").bill === "api", "");
ok("bedrock id", modelBill("us.anthropic.claude-sonnet-4-5-20250929-v1:0") === "metered" && modelBill("claude-opus-4@20250514") === "metered" && modelBill("claude-opus-4") === "", "");
// environ: names only, secrets never kept
const raw = new TextEncoder().encode("ANTHROPIC_API_KEY=sk-ant-SECRET\0CLAUDE_CODE_USE_VERTEX=1\0CLAUDE_CODE_USE_BEDROCK=0\0PATH=/usr/bin\0");
const es = envSummary(raw); const js = JSON.stringify(es);
ok("names", es.names.indexOf("ANTHROPIC_API_KEY") >= 0 && es.on.join() === "CLAUDE_CODE_USE_VERTEX", js);
ok("no values kept", js.indexOf("SECRET") < 0 && js.indexOf("/usr/bin") < 0, js);
// config files on a fake home: malformed JSON, missing files, personal data dropped
// write ~/.claude.json {"oauthAccount":{"billingType":"stripe_subscription","organizationType":"claude_team","emailAddress":"a@b.c"},"projects":{}}
// write ~/.codex/auth.json {"auth_mode":"apikey","OPENAI_API_KEY":"sk-SECRET"}; ~/.gemini/settings.json "{not json"
const ce = configEv("claude", HOMED, "/nonexistent");
ok("claude plan from file", rule("claude", ce, "config").plan === "team", JSON.stringify([...ce.kv]));
ok("no personal data", JSON.stringify([...ce.kv]).indexOf("@") < 0, "");
const xe = configEv("codex", HOMED, "");
ok("codex key presence only", xe.names.indexOf("OPENAI_API_KEY") >= 0 && JSON.stringify([...xe.kv]).indexOf("SECRET") < 0, "");
ok("malformed gemini = unknown", rule("gemini", configEv("gemini", HOMED, ""), "config").bill === "unknown", "");
ok("missing files = unknown", rule("pi", configEv("pi", HOMED + "/none", ""), "config").bill === "unknown", "");
ok("redact plan", planLabel("team", true) === "team" && planLabel("Acme Corp", true) === "plan", "");
```

- [ ] **Step 2: Run** `scriptc build src/features/usage/billing.check.ts -o /tmp/bc && /tmp/bc` → FAIL (module missing).
- [ ] **Step 3: Implement** `billing.ts` (no imports from UI/state; `readText` from `util/fs.ts`, `obj/str/parse` from `util/json.ts`) and `envOf` on both platforms.
- [ ] **Step 4: Run** → `billing: all checks passed`; `sh scripts/check.sh` PASS.
- [ ] **Step 5: Commit** `feat(usage): billing-mode rules from env names, switches and config type fields`.

---

### Task 5: Stamping + live resolution (session → process → config)

**Files:** Create `src/features/usage/bill-live.ts`; Modify `src/features/usage/record.ts` (`stamp`), `src/harness/claude.ts:108` (model evidence), `src/harness/codex.ts:145-149` (plan_type), `src/features/usage/ledger.ts:57-61` (`apply` sets `s.bill/plan/billSrc`); Test `src/features/usage/billing.check.ts` (stamp precedence), `src/harness/harness.check.ts` (claude Bedrock line, codex plan_type line).

**Interfaces — Consumes:** `Bill`, `Det`, `rule`, `provRule`, `configEv`, `envSummary`, `modelBill` (Task 4); `Acc.bill/plan/billSrc` (Task 2). **Produces:**
- record.ts `export function stamp(a: Acc, bill: string, plan: string, src: string): void` — applies when `a.billSrc === ""`, or `src === "session"` and `a.billSrc !== "session"`; never when `src === "config"` (config is never stamped).
- bill-live.ts `export function billOf(s: Sess): Det` — stamped `Acc` → that; else config: `rule(s.h, configEv(s.h, HOME, s.cwd), "config")` cached per `h + "\0" + cwd` for 60 s and by file mtime.
- `export function modeOf(s: Sess, prov: string): Bill` — pi/OpenCode with `prov !== ""`: `provRule` over the live env names (if the session has a pid and was seen) else config; otherwise `billOf(s).bill`.
- `export function sessionBill(s: Sess): Det` — for pi/OpenCode: the mode of the provider with the largest `cp` sum across days (plan = that provider id), else `billOf(s)`.
- A `H.onTick` job: for each session with `s.pid > 0` whose Acc is not session-stamped, at most once per 60 s per pid on Linux: `envSummary(OS.envOf(s.pid))` → `rule(s.h, {names, on, kv: empty}, "process")`; conclusive (`bill !== "unknown"`) → `stamp(a, …, "process")`. The summary for pi/OpenCode is kept in memory per pid (names only) for `modeOf`.
- claude.ts: `const mb = modelBill(model); if (mb) stamp(a, mb, "", "session");` next to `tokens()`. codex.ts: `const pt = str(rl["plan_type"]); if (pt) stamp(a, "plan", pt, "session");` (location per Task 0 Step 7).

- [ ] **Step 1: Failing checks**: in `billing.check.ts`: `const a = newAcc(); stamp(a, "plan", "team", "config")` → `a.billSrc === ""`; `stamp(a, "api", "", "process")` → api/process; `stamp(a, "metered", "", "session")` → metered/session; `stamp(a, "api", "", "process")` → still metered/session. In `harness.check.ts` claude SAMPLES: an assistant line with `"model":"us.anthropic.claude-sonnet-4-5-20250929-v1:0"` and usage → after `claude.usage(a, l)`: `a.bill === "metered" && a.billSrc === "session" && a.cost > 0` (priced via Task 1); codex: a `token_count` event with `rate_limits:{primary:{…},plan_type:"pro"}` → `a.bill === "plan" && a.plan === "pro"`.
- [ ] **Step 2: Run** both checks → FAIL (`stamp` missing).
- [ ] **Step 3: Implement** `stamp`, the adapter lines, `bill-live.ts` (imports `OS`, `HOME`, `sessions`, `ledger`), `ledger.apply()` sets `const b = sessionBill(s); s.bill = b.bill; s.plan = b.plan; s.billSrc = b.src`. Import `bill-live.ts` from `stats.ts` so it registers.
- [ ] **Step 4: Run** → PASS; `sh scripts/check.sh` PASS; `./build.sh && ./agentglass --json --limit 20 | jq -c '.[]|{harness}'` runs (billing fields come in Task 11). Manual on Linux: start `claude` in a scratch dir, `cat /proc/$(pgrep -n claude)/environ | tr '\0' '\n' | cut -d= -f1 | grep -c .` > 0 and agentglass's preview shows the session's mode after ≤ 60 s.
- [ ] **Step 5: Commit** `feat(usage): stamp billing mode from transcript and process evidence, fall back to config`.

---

### Task 6: Mode sums, money format, unpriced line (pure)

**Files:** Create `src/features/usage/costs.ts`, `src/features/usage/costs.check.ts`.

**Interfaces — Consumes:** `Bill`, `MODES`, `tag` (Task 4); `Day` (Task 2). **Produces:**
- `export interface ModeSum { by: number[]; unk: number; um: Map<string, number>; uc: number }` — `by[i]` = cost of `MODES[i]`; `export function newSum(): ModeSum`.
- `export function addDay(m: ModeSum, d: Day, mode: (prov: string) => Bill): void` — every `d.cp` entry into `by[MODES.indexOf(mode(prov))]`; `unk`, `um`, `uc` summed. Cost booked before Task 2 has no `cp` entries on old days only after a re-index — none exist (VERSION bump).
- `export function total(m: ModeSum): number`; `export function single(m: ModeSum): Bill | ""` (the only mode with cost > 0, `""` if mixed or none).
- `export function money(c: number, bill: Bill): string` — `api` → `$4.20`, else `≈$4.20`; ≥ 1000 → grouped without cents (as today's `grp`).
- `export function moneyTag(c: number, bill: Bill): string` — `money + " " + tagWord` where tagWord = `spend` for api, `plan`, `cloud`, `gw`, `?`.
- `export function split(m: ModeSum, narrow: boolean): string` — one mode → `moneyTag`; mixed → parts joined by ` + ` in MODES order; `narrow` → `≈$<total>` (no tag; `$` without `≈` only if single mode is api).
- `export function unpricedLine(m: ModeSum, top: number): string` — `"gpt-x 900K · custom 300K · +2 models · kiro 120 credits (set kiroCreditUsd)"`, `""` when nothing unpriced; models sorted by tokens desc, `kfmt`-style numbers (copy `kfmt` from `stats.ts:19-24` into costs.ts and re-export it from stats.ts to keep one definition).

- [ ] **Step 1: Failing check** `costs.check.ts`:

```ts
ok("api no approx", money(4.2, "api") === "$4.20" && money(4.2, "plan") === "≈$4.20" && money(1234, "metered") === "≈$1,234", money(4.2, "api"));
const m = newSum(); const d = mkDay(); // mkDay(): Day literal with cp {"":3.1, "anthropic":9.2}, unk 1200000, um {"gpt-x":900000,"custom":300000,"m3":1,"m4":1,"m5":1,"m6":1}, uc 120
addDay(m, d, (p: string): Bill => (p === "anthropic" ? "plan" : "api"));
ok("by mode", Math.abs(m.by[0] - 3.1) < 1e-9 && Math.abs(m.by[1] - 9.2) < 1e-9, m.by.join(","));
ok("split mixed", split(m, false) === "$3.10 spend + ≈$9.20 plan", split(m, false));
ok("split narrow", split(m, true) === "≈$12.30", split(m, true));
ok("unpriced line", unpricedLine(m, 2) === "gpt-x 900K · custom 300K · +4 models · kiro 120 credits (set kiroCreditUsd)", unpricedLine(m, 2));
ok("nothing unpriced", unpricedLine(newSum(), 5) === "", "");
```

- [ ] **Step 2: Run** `scriptc build src/features/usage/costs.check.ts -o /tmp/cc && /tmp/cc` → FAIL.
- [ ] **Step 3: Implement.** (The `uc` hint "(set kiroCreditUsd)" is shown only when `uc > 0`.)
- [ ] **Step 4: Run** → PASS; suite PASS.
- [ ] **Step 5: Commit** `feat(usage): cost per billing mode, mode-aware money format, unpriced breakdown`.

---

### Task 7: Projection (pure)

**Files:** Modify `src/features/usage/costs.ts`; Test `src/features/usage/costs.check.ts`.

**Interfaces — Produces:**
- `export interface DayCost { key: string; cost: number; hc: number[] }` — one local day summed over sessions (per mode set by the caller).
- `export function projectToday(hist: DayCost[], today: DayCost, hour: number): number` — `hist` = the 14 days before today (oldest first); profile over days with `cost > 0`; `< 3` such days → `-1`. Result = `today.cost + Σ_{h > hour} profile[h] + max(0, profile[hour] − today.hc[hour])`.
- `export function projectMonth(hist: DayCost[], mtd: number, todayProj: number, todaySpent: number, daysLeft: number): number` — `hist` = last 14 complete days; mean over the days from the first day with data in that window through yesterday; `< 3` days with data → `-1`. Result = `mtd + max(0, todayProj − todaySpent) + daysLeft × mean` (today's remainder from `projectToday` when ≥ 0, else 0).
- `export function daysLeftInMonth(now: number): number` — days after today in this local month, stepping `noon + i × 86400000` with `dayKey` until the month part changes (DST-safe, no `new Date(y, m, d)`).
- `export function monthStart(now: number): string[]` — day keys from the 1st through today.

- [ ] **Step 1: Failing checks**:

```ts
const dc = (k: string, c: number, hrs: number[]): DayCost => { const hc: number[] = []; for (let i = 0; i < 24; i++) hc.push(hrs.indexOf(i) >= 0 ? c / hrs.length : 0); return { key: k, cost: c, hc }; };
const two = [dc("a", 10, [9, 10]), dc("b", 10, [9, 10])];
ok("2 days → none", projectToday(two, dc("t", 0, []), 8) === -1, "");
const three = [dc("a", 10, [9, 10]), dc("b", 0, []), dc("c", 10, [9, 10]), dc("d", 10, [9, 10])];
ok("profile skips zero days", Math.abs(projectToday(three, dc("t", 0, []), 8) - 10) < 1e-9, String(projectToday(three, dc("t", 0, []), 8)));
const spentMore = dc("t", 8, [9]); // 8 spent at 09h, profile 5 at 09h, 5 at 10h
ok("overspent hour adds 0", Math.abs(projectToday(three, spentMore, 9) - 13) < 1e-9, String(projectToday(three, spentMore, 9)));
ok("month", Math.abs(projectMonth(three, 50, 10, 0, 10) - (50 + 10 + 10 * 7.5)) < 1e-9, ""); // mean over a..d = 30/4
ok("month none", projectMonth(two, 50, -1, 0, 10) === -1, "");
// first of the month at noon: daysLeft = days in month − 1; last day: 0
ok("days left last day", daysLeftInMonth(isoMs("2026-10-31T12:00:00")) === 0, "");
ok("days left first", daysLeftInMonth(isoMs("2026-10-01T12:00:00")) === 30, "");
ok("month start on the 1st", monthStart(isoMs("2026-10-01T12:00:00")).join() === "2026-10-01", "");
// DST: 2026-10-25 (Europe) has 25 local hours — must not throw, no hour index ≥ 24
ok("dst", projectToday(three, dc("2026-10-25", 1, [2]), 23) >= 1, "");
```

  (Use local-time ISO strings without `Z`; the check runs in the machine's zone, so the DST line asserts only "no throw, ≥ spent".)
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; suite PASS.
- [ ] **Step 5: Commit** `feat(usage): today and month projection from hourly profile and recent daily mean`.

---

### Task 8: Budget config, state, once-a-day notify

**Files:** Modify `src/features/usage/costs.ts` (pure parts); Create `src/features/usage/summary.ts` (runtime sums over sessions + budget tick); Test `src/features/usage/costs.check.ts`.

**Interfaces — Consumes:** `section("budget")` (`src/util/config.ts:13`), `say` (`src/state.ts:57`), `OS.notify`, `ModeSum`, projections. **Produces:**
- costs.ts `export interface Budget { usd: number; counts: Bill[]; warnAt: number; bad: string }` — `export function parseBudget(o: Obj): Budget` (`usd 0` = none; `counts` `["all"]` → all MODES; invalid `monthlyUsd` (non-number, ≤ 0), `counts` (not an array of known modes/`all`), `warnAt` (not 0 < x < 1) → that field ignored, `bad` names it).
- `export interface BState { state: string; used: number; projected: number; approx: boolean }` — `export function budgetState(b: Budget, month: ModeSum, projByMode: number[]): BState`: used = Σ counted `by`; projected = Σ counted projections (`-1` when unknown); `approx` = a counted `metered` or `gateway` amount > 0, or `plan`/`unknown` counted with > 0; state `over` (used ≥ usd), `watch` (projected > usd or used ≥ warnAt × usd), else `ok`; `""` when `usd === 0`.
- summary.ts `export function sumDays(days: string[], harness: string): ModeSum` (iterates `sessions` + `ledger`, `modeOf(s, prov)`; cached per `days.join + harness` and `L.ver` for 5 s like `agg`), `export function dayCosts(days: string[], harness: string): DayCost[][]` (per mode), `export function costNow(harness: string): { today: ModeSum; month: ModeSum; projToday: number[]; projMonth: number[]; budget: Budget; bs: BState }`; a `H.onTick` job every 60 s: `bs.state === "over"` and `lastNotified !== todayKey()` → `say("warn", "budget exceeded: $… of $…")` and, unless `AGENTGLASS_NOTIFY=0`, `OS.notify("agentglass", "budget", …)`; `lastNotified` in memory only. Startup: `budget.bad` → one `say("warn", "config budget.<field> invalid — ignored")`.

- [ ] **Step 1: Failing checks**:

```ts
const b1 = parseBudget({ monthlyUsd: 200 });
ok("defaults", b1.usd === 200 && b1.counts.join() === "api,metered,gateway" && b1.warnAt === 0.8 && b1.bad === "", JSON.stringify(b1));
ok("string usd ignored", parseBudget({ monthlyUsd: "200" }).usd === 0 && parseBudget({ monthlyUsd: "200" }).bad === "monthlyUsd", "");
ok("warnAt 1.5 ignored", parseBudget({ monthlyUsd: 10, warnAt: 1.5 }).warnAt === 0.8 && parseBudget({ monthlyUsd: 10, warnAt: 1.5 }).bad === "warnAt", "");
ok("all", parseBudget({ monthlyUsd: 10, counts: ["all"] }).counts.length === 5, "");
const mo = newSum(); mo.by[0] = 150; mo.by[1] = 900; // api 150, plan 900 (not counted)
const st1 = budgetState(b1, mo, [170, 1000, 0, 0, 0]);
ok("watch by warnAt", st1.state === "watch" && st1.used === 150 && !st1.approx, JSON.stringify(st1));
mo.by[2] = 60; // metered counted
const st2 = budgetState(b1, mo, [170, 1000, 70, 0, 0]);
ok("over + approx", st2.state === "over" && st2.approx && st2.used === 210, JSON.stringify(st2));
ok("ok", budgetState(parseBudget({ monthlyUsd: 1000 }), mo, [170, 0, 70, 0, 0]).state === "ok", "");
ok("no budget", budgetState(parseBudget({}), mo, [0, 0, 0, 0, 0]).state === "", "");
```

  The once-per-day notify lives in `summary.ts`; expose `export function notifyOnce(bs: BState, day: string, send: (msg: string) => void): boolean` in costs.ts and check: two calls with `over` on the same day → `send` once; next day → again; `ok` → never.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (summary.ts wires `notifyOnce` with a `send` that toasts and, unless `process.env.AGENTGLASS_NOTIFY === "0"`, notifies). **Step 4: Run** → PASS; suite PASS.
- [ ] **Step 5: Commit** `feat(usage): optional monthly budget with watch/over states and a daily notification`.

---

### Task 9: Claude plan allowance gauge (guarded)

**Files:** Modify `src/features/usage/billing.ts` (`allowanceOf`), `src/features/usage/bill-live.ts` (`allowance()`); Test `src/features/usage/billing.check.ts`.

**Interfaces — Produces:**
- billing.ts `export interface Win { pct: number; reset: number }`; `export interface Allow { h5: Win | null; d7: Win | null; hi: string /* "5h" | "7d": the fuller window */ }`; `export function allowanceOf(o: Obj | null, now: number): Allow | null` — accepts only `cachedUsageUtilization.fetchedAtMs` (number, `now − it ≤ 3600000`) and `cachedUsageUtilization.utilization.{five_hour,seven_day}.{utilization,resets_at}`, each window checked on its own: `utilization` a number in 0–100 (a non-integer in 0–1 is scaled × 100), `resets_at` parseable (`isoMs > 0`) and in the future; an invalid window is `null`; `hi` = the window with the higher pct (ties → `7d`); both windows invalid, stale or a wrong shape → `null`.
- bill-live.ts `export function allowance(): Allow | null` — re-reads `~/.claude.json` at most every 60 s (mtime-cached), extracts only `cachedUsageUtilization`, drops the rest; `null` unless some live or today's Claude session resolves to `plan`. A rejected shape logs one line to the existing debug log if one exists, else nothing (no toast).

- [ ] **Step 1: Failing checks**: pinned shape (copied from Task 0 Step 8, fake values): `{cachedUsageUtilization:{fetchedAtMs: NOW-60000, utilization:{five_hour:{utilization:15,resets_at:<now+1h ISO>}, seven_day:{utilization:71,resets_at:<now+3d ISO>}}}}` → `h5.pct 15`, `d7.pct 71`, `hi "7d"`; `five_hour` 80 / `seven_day` 71 → `hi "5h"`; stale (`NOW − 2h`) → null; `utilization` renamed to `util` in both windows → null; `seven_day.utilization: 140` → `d7 null`, `h5` kept, `hi "5h"`; `utilization: 0.42` → pct 42; `resets_at: "soon"` in both → null; missing `seven_day` but valid `five_hour` → `h5` only, `hi "5h"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; suite PASS.
- [ ] **Step 5: Commit** `feat(usage): Claude plan allowance gauge behind a staleness and shape guard`.

---

### Task 10: TUI display — header, Stats, preview, help, `B`

**Files:** Modify `src/features/usage/stats.ts` (`money` call sites `:84,100,104,124-125,459,461`; `agg` `:49-76` adds a `ModeSum` per row and total via `addDay`; summary `:98-105`; table `:114,119-133`; preview `:454-463`; header `:464-475`; footer `:476-480`; help `:481-483`; `key` `:404-432` adds `B`).

**Interfaces — Consumes:** `addDay`, `split`, `moneyTag`, `money`, `unpricedLine`, `single`, `tag`, `costNow`, `allowance`, `billOf`, `sessionBill`, `planLabel`, `REDACT` (`src/features/redact.ts:16`).

Rendering rules (spec §5, exact strings):
- header: `split(today, w < 40)` + ` today` (single mode: `$3.10 spend today`); colour `C.yellow`, `bs.state` `watch` → `C.yellow` bold, `over` → `C.red`; then the Codex gauge (unchanged) and `· cc 5h 15% 7d 71%` from `allowance()`: the `hi` window in `heat(pct / 100)` bold, the other dim; a missing window is left out; when it does not fit, the dim window goes first, then the whole gauge.
- Stats line 1: chips + indexed + `   prices: <PRICES_FROM> · billing: Claude plan (team) · Codex plan (pro) · Gemini spend` — one entry per harness with sessions in the period, mode from the harness's sessions (`mixed` if more than one), assumed (`billSrc` config) entries dim with `*`.
- Stats line 2: starts with `split(sum, false)`, then the token figures as today, then ` · unpriced 1.2M tok` (dim) when `sum.unk > 0`.
- Stats line 3: busiest as today; projection `→ today ≈$14 · month ≈$310` (`$` without `≈` only when every counted mode is api) and with a budget ` of $200 (155%)` (≈ before the figures when `bs.approx`); `W ≥ 130` → appended after busiest, else replaces busiest; `—` + `not enough history` when `-1`.
- table: cost column header `cost`; cell `moneyTag(cost, mode)` or `mixed` (width 12 → widen column to 14, shrink `lw`); a new line under `Σ total`: `unpriced  ` + `unpricedLine(sum, 2)` — box height `nh + 6` only when non-empty (shift `y0` by 1).
- preview: `moneyTag(s.cost, s.bill)` + ` (` + planLabel + `)` when plan; `+ 340K tok unpriced (gpt-x)` when `s.unkTok > 0` (top model from the session's days); `billing assumed from current config` (dim) when `s.billSrc === ""`.
- help: replace the costs line with `["", "cost tags: spend = API key (real), plan = list-price equivalent, cloud = Bedrock/Vertex/Foundry, gw = gateway, ? = unknown; * = assumed from current config"]`, `["B", "budget: current state and the config path"]`, `["", "projection: today from the 14-day hourly profile, month from the 14-day mean; history = what is still on disk"]`.
- `B`: `say("info", bs.state ? "budget $" + usd + "/month (counts " + counts + "): used " + … + " · " + CONFIG_FILE : "no budget — set budget.monthlyUsd in " + CONFIG_FILE)`.

- [ ] **Step 1: Failing check** (the renderers are glue; the formatting logic is in Tasks 6–9). Add to `costs.check.ts` the composed strings the renderer uses: `projText(14.2, 310, parseBudget({monthlyUsd:200}), {state:"watch",used:0,projected:310,approx:false}, true)` → `"→ today $14 · month $310 of $200 (155%)"` and with `approx` → `"→ today ≈$14 · month ≈$310 of $200 (155%)"`; `projText(-1, -1, …)` → `"→ — not enough history"`. Produces `export function projText(today: number, month: number, b: Budget, bs: BState, allApi: boolean): string` in costs.ts. Run → FAIL.
- [ ] **Step 2: Implement** `projText` and the stats.ts changes above.
- [ ] **Step 3: Run** costs check PASS; suite PASS; `./build.sh`.
- [ ] **Step 4: Manual widths** (tmux, read-only on real data): `for w in 80 120 200; do tmux new-session -d -s hc -x $w -y 40 "./agentglass"; sleep 4; tmux send-keys -t hc 3; sleep 2; tmux capture-pane -p -t hc > /tmp/claude-1000/hc-$w.txt; tmux kill-session -t hc; done`. Expected: no line wraps or truncates mid-tag; header shows the split or `≈$x today` at 80; Stats line 3 shows the projection; the unpriced line appears only when something is unpriced. Repeat with a temp `~/.agentglass/config.json` budget (`HOME` stays real; back up and restore the file) at `monthlyUsd: 1` to see the red header and one toast.
- [ ] **Step 5: Commit** `feat(stats): billing tags, unpriced breakdown, projection and budget state in header, Stats and preview`.

---

### Task 11: CLI — `--json` billing fields and `agentglass cost`

**Files:** Modify `src/features/cli.ts:45-46,58-62,103-110` (fields + help); Create `src/features/cost-cli.ts`; Modify `src/main.ts` (import after `./features/cli.ts`); Create `scripts/cost.test.sh`.

**Interfaces — Consumes:** `Sess.bill/plan/billSrc/unkTok/unkCr` (Tasks 2, 5), `costNow` (Task 8), `split`, `unpricedLine`, `MODES`. **Produces:**
- `--json` per session: `billing: { mode: string; plan: string; source: string }` (`source` `"session" | "process" | "config"`; mode `unknown` + source `""` when undetermined), `unpricedTokens: number`, `unpricedCredits: number`. `plan` through `planLabel(…, REDACT)`.
- `agentglass cost [--json] [--harness h] [--check]`: discover (as `cli.ts:93`), `complete(s)` for every session with `mtime ≥ min(month start, today − 15 days)` (the blocking path `ledger.ts:91-96`), then `costNow(h)`. Text: a table with rows `today`, `7 days`, `month to date`, `projected month`, columns per mode with cost > 0 plus `unpriced`; then the unpriced line and `budget: …`. `--json`: `{today:{byMode:{api,plan,metered,gateway,unknown},unpriced:{tokens,byModel:{…},credits}}, month:{byMode,unpriced,projected:{byMode, total}|null}, budget:{monthlyUsd,counts,used,projected,state,approx}|null}`. Exit 0; with `--check` and `state === "over"` → exit 3.
- Help: `CMDS` row `["agentglass cost [--json] [--check]", "costs today / month by billing mode, unpriced usage, projection, budget (--check: exit 3 when over budget)"]`; `--json fields` line adds `billing{mode,plan,source} unpricedTokens unpricedCredits`.

- [ ] **Step 1: Failing shell test** `scripts/cost.test.sh`:

```sh
#!/bin/sh
# agentglass cost + --json billing fields against a fake HOME (one Claude API-key session, one unpriced model): sh scripts/cost.test.sh
set -e
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
AGENTGLASS_OUT="$t/ag" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }
sh "$here/scripts/build-info.sh"
p="$t/home/.claude/projects/-w-app"; mkdir -p "$p" "$t/home/.agentglass"
now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
printf '{"type":"user","sessionId":"s1","cwd":"/w/app","timestamp":"%s","message":{"role":"user","content":"hi"}}\n' "$now" > "$p/s1.jsonl"
printf '{"type":"assistant","sessionId":"s1","timestamp":"%s","message":{"id":"m1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1000000,"output_tokens":0}}}\n' "$now" >> "$p/s1.jsonl"
printf '{"type":"assistant","sessionId":"s1","timestamp":"%s","message":{"id":"m2","role":"assistant","model":"gpt-x-unknown","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":5000,"output_tokens":0}}}\n' "$now" >> "$p/s1.jsonl"
printf '{"apiKeyHelper":"/bin/true"}\n' > "$t/home/.claude/settings.json"
printf '{"budget":{"monthlyUsd":1}}\n' > "$t/home/.agentglass/config.json"
j=$(HOME="$t/home" AGENTGLASS_OFFLINE=1 "$t/ag" --json)
eq mode "$(echo "$j" | jq -r '.[0].billing.mode')" api
eq source "$(echo "$j" | jq -r '.[0].billing.source')" config
eq unpriced "$(echo "$j" | jq -r '.[0].unpricedTokens')" 5000
c=$(HOME="$t/home" AGENTGLASS_OFFLINE=1 "$t/ag" cost --json)
eq state "$(echo "$c" | jq -r '.budget.state')" over
eq approx "$(echo "$c" | jq -r '.budget.approx')" false
eq bymodel "$(echo "$c" | jq -r '.today.unpriced.byModel["gpt-x-unknown"]')" 5000
set +e; HOME="$t/home" AGENTGLASS_OFFLINE=1 "$t/ag" cost --check > /dev/null; rc=$?; set -e
eq exit "$rc" 3
HOME="$t/home" AGENTGLASS_OFFLINE=1 "$t/ag" cost | grep -q "spend" || { echo "FAIL text has no spend tag"; fail=1; }
[ $fail = 0 ] && echo "cost cli: all checks passed"; exit $fail
```

  (Line shapes follow `src/harness/harness.check.ts` claude SAMPLES; adjust field names to whatever that file uses if they differ.)
- [ ] **Step 2: Run** `sh scripts/cost.test.sh` → FAIL (`billing` null / unknown command).
- [ ] **Step 3: Implement** `cost-cli.ts` (`H.cli.push((args) => { if (args[0] !== "cost") return false; S.cli = true; … })`) and the cli.ts fields/help.
- [ ] **Step 4: Run** the test → `cost cli: all checks passed`; `sh scripts/check.sh` PASS; old-behavior diff (Task 2 Step 4 commands) still clean for `tokens`/`costUsd`.
- [ ] **Step 5: Commit** `feat(cli): billing fields in --json; agentglass cost with projection and budget check`.

---

### Task 12: Real-life verification, docs, final review

**Files:** Modify `README.md` (cost section `:50-51,95-115`, Kiro note `:249-250`: tags, unpriced line, projection limits, budget config, `agentglass cost`, privacy note on what is read), `src/features/cli.ts` usage text if not already complete.

- [ ] **Step 1: Real sessions (read-only)**: `./agentglass --json --subagents --limit 400 | jq -c '.[]|{harness,billing,unpricedTokens,unpricedCredits}' | sort | uniq -c | sort -rn | head -20`. Expected on this machine: Claude `plan`/`team` (config, from `stripe_subscription`), Codex `plan`/`pro` (session) where rollouts carry `plan_type`, Gemini `api` (config `gemini-api-key`), OpenCode anthropic `plan` (oauth), Kiro `plan`. Any mismatch → fix the rule, not the expectation, and re-run Task 4 checks.
- [ ] **Step 2: Contract diff**: Task 2 Step 4 commands against `/tmp/claude-1000/hc-before.json` → only added fields differ.
- [ ] **Step 3: Live process step**: start one `claude` with `ANTHROPIC_API_KEY=dummy` in a scratch dir (no prompt sent), wait 60 s → its session (once written) shows `spend` with source `process`; `grep -c dummy ~/.agentglass/cache/ledger.json` → 0 after quit.
- [ ] **Step 4: TUI**: header/Stats/preview at 80/120/200 columns (Task 10 Step 4), `agentglass cost` and `agentglass cost --json | jq .` on real data, `B` in Stats, `--redact` run shows tags and generic plan names.
- [ ] **Step 5: Docs**: README sections above; `?` help text checked in the TUI. Run `sh scripts/check.sh` → PASS. Commit `docs: billing modes, unpriced usage, projection and budget`.
- [ ] **Step 6: Final whole-branch review** (most capable model) against spec.md and this plan's Review Focus; one fix pass; push, PR to `main` ("honest costs: billing modes, unpriced breakdown, projection, budget"), CI green, rebase-merge, remove the worktree and branch.
