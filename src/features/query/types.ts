// agentglass — filter language: shared types (clauses, attributes, values, errors)
// SPDX-License-Identifier: Apache-2.0
export type Ent = "session" | "day" | "call" | "event";
export type AType = "enum" | "text" | "path" | "bool" | "usd" | "tok" | "num" | "ratio" | "dur" | "size" | "date";
// op ∈ is | is_not | is_one_of | is_not_one_of | ~ | !~ | > | >= | < | <=  (= and != are parsed and printed as is / is_not)
// neg: "not"/"-" before a numeric comparison (not cost > 2 also matches unknown cost); every other negation folds into the inverse op
export interface Clause { key: string; op: string; vals: string[]; neg: boolean; pinned: boolean }
export interface QErr { msg: string; col: number /* 0-based column into the input */ }
export interface Parsed { cs: Clause[]; err: QErr | null; notes: string[] /* semantic warnings */ }
// an attribute's value: a number, or lowercase strings (multi-valued attributes have several); unk = unknown (unpriced, untimed, …)
export interface Val { n: number; ss: string[]; unk: boolean }
// registry entry; enumFn names a dynamic value list ("harness"), ops [] = the type's default operators
export interface Attr { key: string; aliases: string[]; ent: Ent; type: AType; multi: boolean; enumVals: string[]; enumFn: string; ops: string[] }
