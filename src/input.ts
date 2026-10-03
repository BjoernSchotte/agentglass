// agentglass — keyboard and mouse: raw input → key names → actions
// SPDX-License-Identifier: Apache-2.0
import { run } from "./util/fs.ts";
import { clean, numAt } from "./util/text.ts";
import { S, say } from "./state.ts";
import { H, tabAt } from "./hooks.ts";
import { buildView, titleOf, parentOf, isOpen, expanded, collapsed, current } from "./model/sessions.ts";
import { procView, procAt, procSess, tmuxTarget, sharedDaemon } from "./model/procs.ts";
import { copyText, ask, confirm, target, targetPid, openFileN, pageDetail, sendTmux, owner, sendPrompt, resume, killPid, trash } from "./actions.ts";
import { openTranscript, moveCur, cycleSub } from "./ui/transcript.ts";
import { openDetail, stepDetail } from "./ui/detail.ts";
import { prevKind, prevIdx, prevKids } from "./ui/list.ts";
import { footX0, footX1, footKey } from "./ui/footer.ts";
import { tabX0, tabX1 } from "./ui/header.ts";
import { quit } from "./term.ts";
import { harnessOf } from "./harness/index.ts";
import { OS } from "./platform/index.ts";

export function tokens(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      if (s[i + 1] === "[" || s[i + 1] === "O") {
        let j = i + 2;
        while (j < s.length && !/[A-Za-z~]/.test(s[j])) j++;
        out.push(s.slice(i, j + 1)); i = j + 1; continue;
      }
      out.push("esc"); i++; continue;
    }
    const a = s.charCodeAt(i);
    const n = a >= 0xd800 && a <= 0xdbff ? 2 : 1;
    out.push(s.slice(i, i + n)); i += n;
  }
  return out;
}
export function keyName(k: string): string {
  const m: Record<string, string> = {
    "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left", "\x1bOA": "up", "\x1bOB": "down",
    "\x1b[5~": "pgup", "\x1b[6~": "pgdn", "\x1b[H": "home", "\x1b[F": "end", "\x1b[1~": "home", "\x1b[4~": "end", "\x1bOH": "home", "\x1bOF": "end",
    "\r": "enter", "\n": "enter", "\x7f": "bs", "\b": "bs", "\t": "tab", "\x03": "ctrl-c", "\x15": "ctrl-u", "\x17": "ctrl-w", "\x0b": "ctrl-k", "\x10": "ctrl-p", "\x0e": "ctrl-n",
  };
  return m[k] ?? k;
}
// the input line's feature handlers (H.input): true = one of them asks to keep the line open
function inputEv(ev: string): boolean { let keep = false; for (const f of H.input) if (f(S.inputAction, ev, S.inputText)) keep = true; return keep; }
export function onInput(k: string): void {
  for (const f of H.modal) if (f(S.mode, k)) return; // the palette: Ctrl+K from any view, then its own keys
  if (S.mode === "input") {
    const was = S.inputText;
    if (k === "enter") {
      if (!inputEv("enter")) { // true: invalid input stays open, the error shows after the text
        S.mode = S.prevMode; S.inputErr = "";
        const v = S.inputText;
        if (S.inputAction === "send") { const s = target(); if (s && v.trim()) sendPrompt(s, v); }
        else if (S.inputAction === "sendpane") { const p = procAt(S.psel); const t = p ? tmuxTarget(p.pid) : ""; if (t && v.trim()) sendTmux(t, v); }
      }
    } else if (k === "esc") { S.mode = S.prevMode; inputEv("esc"); S.inputErr = ""; }
    else if (k === "tab") inputEv("tab");
    else if (k === "bs") S.inputText = Array.from(S.inputText).slice(0, -1).join("");
    else if (k === "ctrl-u") S.inputText = "";
    else if (k === "ctrl-w") S.inputText = S.inputText.replace(/\S*\s*$/, "");
    else if (k.length <= 2 && k.charCodeAt(0) >= 32) S.inputText += k;
    if (S.mode === "input" && k !== "tab" && S.inputText !== was) inputEv("change"); // tab reports its own change
    return;
  }
  if (S.mode === "confirm") {
    if (k === "y" || k === "Y") {
      S.mode = S.prevMode;
      const s = target();
      if (S.confirmAction === "TERM") killPid(targetPid(), "SIGTERM");
      else if (S.confirmAction === "KILL") killPid(targetPid(), "SIGKILL");
      else if (S.confirmAction === "trash" && s) trash(s);
    } else if (k === "n" || k === "N" || k === "esc" || k === "q") S.mode = S.prevMode;
    return;
  }
  if (S.mode === "help") {
    if (k === "down" || k === "j" || k === "wheeldown") S.helpScroll++;
    else if (k === "up" || k === "k" || k === "wheelup") S.helpScroll--;
    else if (k === "pgdn" || k === " ") S.helpScroll += 10;
    else if (k === "pgup") S.helpScroll -= 10;
    else { S.mode = S.prevMode; S.helpScroll = 0; }
    return;
  }
  if (k === "ctrl-c") quit();
  for (const f of H.keys) if (f(S.mode, k)) return; // feature keys win over built-ins
  if (k === "?") { S.prevMode = S.mode; S.mode = "help"; return; }

  const tv = S.tv;
  if (S.mode === "transcript" && tv) {
    const vh = S.H - 4;
    if (k === "esc" || k === "q" || k === "left") { S.mode = "list"; S.tv = null; return; }
    if (k === "up" || k === "k") moveCur(tv, -1, vh);
    else if (k === "down" || k === "j") moveCur(tv, 1, vh);
    else if (k === "enter" || k === "right") openDetail(tv.cur);
    else if (k === "wheelup") { tv.scroll -= 3; tv.follow = false; }
    else if (k === "wheeldown") tv.scroll += 3;
    else if (k === "pgup" || k === "b") { tv.scroll = Math.max(0, tv.scroll - (vh - 1)); tv.follow = false; tv.cur = numAt(tv.lineEv, tv.scroll, tv.cur); }
    else if (k === "pgdn" || k === " ") { tv.scroll += vh - 1; tv.cur = numAt(tv.lineEv, Math.min(tv.scroll, tv.lines.length - 1), tv.cur); }
    else if (k === "g" || k === "home") { tv.scroll = 0; tv.cur = 0; tv.follow = false; }
    else if (k === "G" || k === "end" || k === "f") tv.follow = true;
    else if (k === "t") tv.expand = !tv.expand;
    else if (k === "s") ask("send to " + tv.s.h, "send", "");
    else if (k === "R") resume(tv.s);
    else if (k === "n" || k === "N") cycleSub(k === "n" ? 1 : -1);
    else if (k === "u") { const par = parentOf(tv.s); if (par) openTranscript(par); }
    // tv may have been replaced (n/N/u): the follow check applies to the one now shown
    const cur = S.tv;
    if (cur && (k.startsWith("wheel") || k === "pgdn" || k === " ")) { if (cur.lines.length && cur.scroll >= cur.lines.length - vh) cur.follow = true; }
    return;
  }
  const dv = S.dv;
  if (S.mode === "detail" && dv) {
    const vh = S.H - 4;
    if (k === "esc" || k === "q" || k === "left" || k === "backspace") { S.mode = "transcript"; S.dv = null; return; }
    if (k === "up" || k === "k") dv.scroll--;
    else if (k === "down" || k === "j") dv.scroll++;
    else if (k === "wheelup") dv.scroll -= 3;
    else if (k === "wheeldown") dv.scroll += 3;
    else if (k === "pgup" || k === "b") dv.scroll -= vh - 1;
    else if (k === "pgdn" || k === " ") dv.scroll += vh - 1;
    else if (k === "g" || k === "home") dv.scroll = 0;
    else if (k === "G" || k === "end") dv.scroll = dv.lines.length;
    else if (k === "]" || k === "n") stepDetail(1);
    else if (k === "[" || k === "p") stepDetail(-1);
    else if (k === "tab") { if (dv.files.length) dv.fsel = (dv.fsel + 1) % dv.files.length; }
    else if (k === "o" || k === "enter") openFileN(dv.fsel, false);
    else if (k === "e") openFileN(dv.fsel, true);
    else if (k === "v") pageDetail();
    else if (k === "z") { S.foldAll = !S.foldAll; S.foldOpen = []; dv.lw = -1; }
    else if (k === "w") { S.wrapCode = !S.wrapCode; dv.lw = -1; say("info", S.wrapCode ? "wrapping long lines" : "cutting long lines at the edge"); }
    else if (k === "y") copyText(dv.plain, dv.plain.length + " chars");
    else if (k.length === 1 && "123456789".indexOf(k) >= 0) openFileN(Number(k) - 1, false);
    return;
  }

  // list mode
  if (k === "q") quit();
  const ntabs = 2 + H.tabs.length;
  if (k === "tab") { S.tab = (S.tab + 1) % ntabs; return; }
  if (k.length === 1 && "123456789".indexOf(k) >= 0 && Number(k) <= ntabs) { S.tab = Number(k) - 1; return; }
  if (k === "?") return;
  const xt = tabAt(S.tab - 2);
  if (xt) { xt.key(k); return; }
  const page = Math.max(1, S.listH - 1);
  if (S.tab === 0) {
    if (k === "up" || k === "k" || k === "wheelup") S.sel--;
    else if (k === "down" || k === "j" || k === "wheeldown") S.sel++;
    else if (k === "pgup") S.sel -= page;
    else if (k === "pgdn") S.sel += page;
    else if (k === "home" || k === "g") S.sel = 0;
    else if (k === "end" || k === "G") S.sel = S.view.length - 1;
    else if (k === "enter" || k === "right") { const s = current(); if (s) openTranscript(s); }
    else if (k === " ") { // fold/unfold the subagent tree of the selected session (or of a subagent's parent)
      const cur = current();
      const root = cur && cur.depth === 1 ? parentOf(cur) : cur;
      if (root && root.subs.length) {
        if (isOpen(root)) { collapsed.add(root.path); expanded.delete(root.path); } else { expanded.add(root.path); collapsed.delete(root.path); }
        buildView(); const i = S.view.indexOf(root); if (i >= 0 && cur !== root && !isOpen(root)) S.sel = i;
      }
    }
    else if (k === "s") { const c = current(); const s = c ? owner(c) : null; if (s) ask("send to " + s.h + (c !== s ? " parent" : "") + (s.pid ? " (live)" : " (headless)"), "send", ""); }
    else if (k === "R") { const s = current(); if (s) resume(s); }
    else if (k === "x") { const s = current(); const w = s && s.pid ? sharedDaemon(targetPid()) : ""; if (w) say("warn", w); else if (s && s.pid) confirm("SIGTERM agent pid " + targetPid() + "?", "TERM"); else say("warn", "session not running"); }
    else if (k === "D") { const s = current(); if (s) { if (s.pid) say("warn", "session is live — stop it first"); else if (!harnessOf(s.h).files) say("warn", harnessOf(s.h).label + " sessions can't be moved to the trash"); else confirm("Move “" + clean(titleOf(s)).slice(0, 40) + "” to " + OS.trashName + "?", "trash"); } }
    else if (k === "y") { const s = current(); if (s) copyText(s.id, s.id); }
    S.sel = Math.max(0, Math.min(S.sel, S.view.length - 1));
  } else {
    if (k === "up" || k === "k" || k === "wheelup") S.psel--;
    else if (k === "down" || k === "j" || k === "wheeldown") S.psel++;
    else if (k === "home" || k === "g") S.psel = 0;
    else if (k === "end" || k === "G") S.psel = procView.length - 1;
    else if (k === "enter" || k === "right") { const p = procAt(S.psel); const s = p ? procSess(p) : null; if (s) openTranscript(s); else say("info", "no session linked to this process"); }
    else if (k === "x" || k === "X") { // a shared daemon (OpenCode 2.x) runs every session: refused, the warning says how to stop it
      const p = procAt(S.psel); const w = p ? sharedDaemon(p.pid) : "";
      if (w) say("warn", w);
      else if (p) confirm(k === "x" ? "SIGTERM " + p.h + " pid " + p.pid + "?" : "SIGKILL " + p.h + " pid " + p.pid + " (no cleanup)?", k === "x" ? "TERM" : "KILL");
    }
    else if (k === "s") {
      const p = procAt(S.psel); const s = p ? procSess(p) : null; const t = p ? tmuxTarget(p.pid) : "";
      if (s) ask("send to " + s.h + " (live)", "send", "");
      else if (t) ask("send to tmux " + t, "sendpane", ""); // fresh agent without a session file yet
      else say("warn", "no session linked and not in tmux");
    }
    else if (k === "a") { const p = procAt(S.psel); const t = p ? tmuxTarget(p.pid) : ""; if (t && process.env.TMUX) { run("tmux", ["switch-client", "-t", t]); say("ok", "switched to " + t); } else say("warn", t ? "not inside tmux — attach with: tmux a -t " + t : "not running in tmux"); }
    S.psel = Math.max(0, Math.min(S.psel, procView.length - 1));
  }
}
export function onMouse(k: string): void {
  const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(k);
  if (!m) return;
  const b = Number(m[1] ?? "0"); const x = Number(m[2] ?? "1") - 1; const y = Number(m[3] ?? "1") - 1; // groups are string | undefined: default them or every derived index is untyped
  for (const f of H.mouse) if (f(S.mode, b, x, y, m[4] === "M")) return;
  if (b === 64 || b === 65) { // wheel: over the preview it scrolls nothing, elsewhere it drives the focused view
    if (S.mode === "list" && S.tab === 0 && x >= S.prevX0 && x < S.prevX1 && y >= S.prevY0) return;
    onInput(b === 64 ? "wheelup" : "wheeldown");
    return;
  }
  if (m[4] !== "M") return; // ignore releases
  if (b === 2) { onInput("esc"); return; } // right click = back
  if (b !== 0) return;
  const now = Date.now();
  const dbl = y === S.lastClickY && now - S.lastClickAt < 450;
  S.lastClickY = y; S.lastClickAt = now;
  if (S.mode === "help") { onInput("esc"); return; }
  if (S.mode === "input" || S.mode === "confirm") return;
  if (y === S.H - 1) { // footer hints are buttons
    for (let i = 0; i < footKey.length; i++) if (x >= numAt(footX0, i, 0) && x < numAt(footX1, i, 0)) { onInput(footKey[i]); return; }
    return;
  }
  const dv = S.dv;
  if (S.mode === "detail" && dv) {
    const li = dv.scroll + (y - 2);
    const fi = dv.fileRow.indexOf(li);
    if (y >= 2 && fi >= 0) { if (dv.fsel === fi || dbl) openFileN(fi, false); else dv.fsel = fi; }
    const fo = dv.foldRow.indexOf(li);
    if (y >= 2 && fo >= 0) { // toggle that one block
      const id = numAt(dv.foldId, fo, -1);
      if (S.foldAll) { S.foldAll = false; S.foldOpen = dv.foldId.filter((x) => x !== id); }
      else if (S.foldOpen.indexOf(id) >= 0) S.foldOpen = S.foldOpen.filter((x) => x !== id);
      else S.foldOpen.push(id);
      dv.lw = -1;
    }
    return;
  }
  const tv = S.tv;
  if (S.mode === "transcript" && tv) {
    const li = tv.scroll + (y - 2);
    if (y < 2 || li >= tv.lines.length) return;
    const ei = numAt(tv.lineEv, li, -1);
    if (ei < 0) return;
    if (ei === tv.cur || dbl) openDetail(ei); else { tv.cur = ei; tv.follow = false; }
    return;
  }
  if (S.mode !== "list") return;
  if (y === 0) { for (let i = 0; i < tabX0.length; i++) if (x >= numAt(tabX0, i, 0) && x < numAt(tabX1, i, 0)) S.tab = i; return; }
  const xt = tabAt(S.tab - 2);
  if (xt) { const f = xt.mouse; if (f) f(x, y, dbl); return; }
  const ps = S.prevSess;
  if (S.tab === 0 && ps && x >= S.prevX0 && x < S.prevX1 && y >= S.prevY0) { // preview rows jump straight in
    const r = y - S.prevY0;
    const kind = numAt(prevKind, r, 0); const at = numAt(prevIdx, r, 0);
    if (kind === 1 && at < prevKids.length) { openTranscript(prevKids[at]); return; }
    if (kind === 2 && at < ps.evs.length) {
      const e = ps.evs[at];
      openTranscript(ps);
      const t = S.tv;
      if (t) { t.focusKind = e.kind; t.focusTs = e.ts; t.focusText = e.text; }
    }
    return;
  }
  if (x < S.listX || x >= S.listX + S.listW || y < S.listY || y >= S.listY + S.listH) return;
  if (S.tab === 0) { const i = S.top + (y - S.listY); if (i < S.view.length && (i === S.sel || dbl)) { S.sel = i; const s = current(); if (s) openTranscript(s); } else if (i < S.view.length) S.sel = i; }
  else if (S.tab === 1) { const i = S.ptop + (y - S.listY); if (i < procView.length && (i === S.psel || dbl)) { S.psel = i; onInput("enter"); } else if (i < procView.length) S.psel = i; }
}
