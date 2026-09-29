// agentglass — where a session's records come from: files by default (byte cursor), adapters may bring their own (OpenCode: SQLite rows by seq)
// SPDX-License-Identifier: Apache-2.0
import { statSync } from "node:fs";
import { readBytes, readLines } from "../util/fs.ts";
import type { Sess } from "../model/types.ts";
import type { SessionSource } from "./types.ts";

export const FILE_SOURCE: SessionSource = {
  stat: (s: Sess) => { try { const st = statSync(s.path); return { size: st.size, mtime: st.mtimeMs }; } catch (e) { return null; } },
  align: (s: Sess, at: number) => {
    if (at <= 0) return 0;
    const b = readBytes(s.path, at - 1, 1048576); // the byte before `at`: a newline means `at` already starts a line
    let i = 0; while (i < b.length && b[i] !== 10) i++;
    return i < b.length ? at + i : at;
  },
  lines: (s: Sess, from: number, to: number) => {
    const r = readLines(s.path, from, to, false);
    if (r.lines.length && r.lines[r.lines.length - 1] === "") r.lines.pop(); // the split leaves "" after the final newline
    return r;
  },
  unit: 1,
};
