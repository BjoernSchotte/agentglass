// agentglass — OTLP export: the span records the builder makes and the encoder turns into OTLP/JSON
// SPDX-License-Identifier: Apache-2.0

// one attribute: t = "s" string, "i" int, "d" double, "b" bool, "as" string array
export interface Attr { k: string; t: string; s: string; n: number; b: boolean; a: string[] }
export interface XEvent { name: string; t: number; attrs: Attr[] }
export interface XSpan {
  op: string; name: string; spanId: string; parentId: string; kind: number; // op invoke_agent | chat | execute_tool; kind 1 INTERNAL, 3 CLIENT
  t0: number; t1: number; est: boolean; err: string; errMsg: string; // ms; err = error.type ("" = ok)
  sess: string; agent: string; attrs: Attr[]; events: XEvent[]; // sess = the (sub)session the span belongs to; agent = subagent type ("" = the harness)
  // facts the encoder turns into attributes
  model: string; respModel: string; provider: string; respId: string; models: string[];
  nIn: number; nOut: number; cr: number; cw: number; rs: number; cost: number; unk: number; exact: boolean; hasUsage: boolean; total: boolean; // total = fx: the growth of the session totals since the last export (export.ts fxDelta)
  provId: string; // chat: the provider id the record logged (pi/OpenCode: its config's name — a gateway, openrouter …), "" = none
  bill: string; // chat: honest-costs mode of this request ("" on other spans)
  tool: string; callId: string; mcp: string; prog: string; exit: number; skill: string; superseded: boolean; // exit -1 = unknown
  input: string; output: string; args: string; result: string; // content, sent only with --content
  open: boolean; // execute_tool still waiting for its result
}
export interface XTurn {
  h: string; rootId: string; path: string; key: string; index: number; traceId: string;
  t0: number; t1: number; closed: boolean; closedBy: string; compacted: boolean; ver: string; cwd: string; branch: string; remote: string;
  spans: XSpan[]; // spans[0] = the root invoke_agent
  fx: number[]; // fx: the session totals when this turn closed (in, out, cache read, cache write, $, unpriced); [] = none
  fxOn: boolean; // fx: this turn carries the session's delta in the current send (export.ts fxDelta)
}

export function attrS(k: string, v: string): Attr { return { k, t: "s", s: v, n: 0, b: false, a: [] }; }
export function attrI(k: string, v: number): Attr { return { k, t: "i", s: "", n: Math.round(v), b: false, a: [] }; }
export function attrD(k: string, v: number): Attr { return { k, t: "d", s: "", n: v, b: false, a: [] }; }
export function attrB(k: string, v: boolean): Attr { return { k, t: "b", s: "", n: 0, b: v, a: [] }; }
export function attrA(k: string, v: string[]): Attr { return { k, t: "as", s: "", n: 0, b: false, a: v }; }

export function newSpan(op: string, name: string, spanId: string, parentId: string, t0: number, sess: string): XSpan {
  return {
    op, name, spanId, parentId, kind: op === "chat" ? 3 : 1, t0, t1: t0, est: false, err: "", errMsg: "", sess, agent: "", attrs: [], events: [],
    model: "", respModel: "", provider: "", respId: "", models: [],
    nIn: 0, nOut: 0, cr: 0, cw: 0, rs: 0, cost: 0, unk: 0, exact: false, hasUsage: false, total: false, provId: "", bill: "",
    tool: "", callId: "", mcp: "", prog: "", exit: -1, skill: "", superseded: false, input: "", output: "", args: "", result: "", open: false,
  };
}
// resource service.name and gen_ai.agent.name per harness
const SERVICE = new Map<string, string>([["claude", "claude-code"], ["codex", "codex"], ["gemini", "gemini-cli"], ["pi", "pi"], ["opencode", "opencode"], ["kiro", "kiro-cli"], ["fx", "fx"]]);
const AGENT = new Map<string, string>([["claude", "Claude Code"], ["codex", "Codex"], ["gemini", "Gemini CLI"], ["pi", "pi"], ["opencode", "OpenCode"], ["kiro", "Kiro"], ["fx", "fx"]]);
export function serviceName(h: string): string { return SERVICE.get(h) ?? h; }
export function agentName(h: string): string { return AGENT.get(h) ?? h; }
