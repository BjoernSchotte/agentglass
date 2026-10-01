// agentglass — Gemini CLI (~/.gemini) adapter
// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import type { Obj } from "../util/json.ts";
import { HOME } from "../util/fs.ts";
import type { Ev, Sess } from "../model/types.ts";
import { C } from "../ui/theme.ts";
import type { Acc } from "../features/usage/record.ts";
import type { AddFn, HarnessAdapter } from "./types.ts";

function roots(): string[] { return [join(HOME, ".gemini", "tmp")]; }
function scan(add: AddFn): void { /* Task 3 */ }
function parse(o: Obj, out: Ev[], s: Sess | null): void { /* Task 3 */ }
function busy(s: Sess): boolean { return false; }
function usage(a: Acc, l: string): void { /* Task 4 */ }

export const gemini: HarnessAdapter = {
  id: "gemini", label: "Gemini", glyph: "✦", mark: "✦", color: () => C.gemini,
  bin: "gemini", procs: ["gemini"],
  roots, scan, headBytes: 65536,
  parse, busy,
  liveCwd: true, // no lock, no registry, the file is opened per write
  headless: (s: Sess, msg: string) => ["--resume", s.id, "-p", msg], // runs in s.cwd: gemini looks the id up in that project only
  resume: (s: Sess) => ["--resume", s.id],
  files: (s: Sess) => [s.path],
  usage,
};
