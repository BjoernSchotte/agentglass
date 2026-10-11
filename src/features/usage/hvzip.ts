// agentglass — the ledger's day heavy texts (tool / program / command line / file maps as JSON, ~a third of a long-running
// process's memory) kept compressed: a long-running reader (serve) installs this and calls zipStep on its cadence; each
// day's text becomes its gzip (~3.7x smaller, 0.5 ms per day to pack, 0.1 ms to unpack on first use). The cache file is
// unchanged: a save writes the text (record.ts hvText). The TUI does not install it (its saves would unpack every day).
// SPDX-License-Identifier: Apache-2.0
import { ledger } from "./ledger.ts";
import { HEAVY } from "./record.ts";
import { gzip } from "../../util/gzip.ts";
import { gunzipCapped } from "../../util/inflate.ts";

const SMALL = 256;
const UNZIP_MAX = 268435456; // a day's text is at most a few hundred KB; a corrupt stream stops here
export function zipOn(): void {
  HEAVY.zip = (t: string): Uint8Array => gzip(new TextEncoder().encode(t));
  HEAVY.unzip = (z: Uint8Array): string => { const r = gunzipCapped(z, UNZIP_MAX); return r.err ? "" : new TextDecoder("utf-8").decode(r.out); };
}
// compress day texts for about budget ms; true = none left (until a day is packed to text again: HEAVY.texts)
export function zipStep(budget: number): boolean {
  const zip = HEAVY.zip; if (!zip || HEAVY.texts <= 0) return true;
  const t0 = Date.now();
  for (const a of ledger.values()) for (const d of a.days.values()) {
    if (!d.hv || d.hx || d.hv.length < SMALL) continue; // a near-empty day ({"tt":{},…}) packs larger than it is
    if (Date.now() - t0 >= budget) return false;
    const z = zip(d.hv); if (z.length < d.hv.length && HEAVY.unzip(z) === d.hv) { d.hz = z; d.hv = ""; } // the text goes only when it comes back exactly: a save writes what unzip gives
  }
  HEAVY.texts = 0;
  return true;
}
