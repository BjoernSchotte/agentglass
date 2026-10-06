// agentglass — the argument rules every command shares: a value never starts with "--", so a value flag never swallows
// the flag after it (a bare `--watch --otlp --filter …` took --filter for its URL, dropped the filter and exported every
// live session), and "--flag=value" is "--flag value" (main() splits it once, for every parser)
// SPDX-License-Identifier: Apache-2.0

// the value of the flag at args[i]: the next argument; null when there is none or it is a flag
export function argVal(args: string[], i: number): string | null {
  if (i + 1 >= args.length) return null;
  const v = String(args[i + 1]);
  return v.startsWith("--") ? null : v;
}
// "--flag=value" → "--flag", "value"
export function splitEq(args: string[]): string[] {
  const o: string[] = [];
  for (const a of args) {
    const e = a.indexOf("=");
    if (a.startsWith("--") && e > 2) { o.push(a.slice(0, e)); o.push(a.slice(e + 1)); } else o.push(a);
  }
  return o;
}
// the first argument a command does not take, as the message of its usage error ("" = none): an unknown flag, a stray
// word, a value flag without its value. vals take a value, bools do not, opt (a subset of vals) may go without one.
// Nothing is ignored: a misspelled or swallowed --filter would widen what is shown or sent.
export function badArg(args: string[], vals: string[], bools: string[], opt: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (vals.indexOf(a) >= 0) {
      if (argVal(args, i) !== null) i++;
      else if (opt.indexOf(a) < 0) return a + " needs a value";
    } else if (bools.indexOf(a) < 0) return a.startsWith("-") ? "unknown option " + a : "unexpected argument " + a;
  }
  return "";
}
