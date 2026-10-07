#!/bin/sh
# machine-wide slots for scripts/check.sh: at most CHECK_MAX_SUITES suites (default 2) and CHECK_MAX_BUILDS scriptc
# builds (default cores/4, 1..6; each build runs up to 8 clang shards) at once across every worktree and agent on this
# machine. Unlimited, a dozen agents' suites drove load averages to 300–1000 and ran out of RAM.
#   sh scripts/check-lock.sh run <suite|build> <cmd>…  take a slot (waiting for one), run cmd, free it; cmd's exit code
#   sh scripts/check-lock.sh status                     the held slots and their worktrees
# check.sh sources it for its own suite slot and routes every scriptc (its jobs' and the tests') through `run build`.
# A wait never fails: a waiting suite says so once, naming the holders; a waiting build is silent (its output is
# scriptc's). No deadlock: a build slot is held only while scriptc runs, never while waiting for anything, so a suite
# that holds a suite slot and waits for build slots always gets them; nested takes (a suite inside a suite, scriptc
# inside a build) pass straight through.
# Slots live in CHECK_LOCK_DIR (default ~/.cache/agentglass-check). With flock (Linux) a slot is a locked file, freed by
# the kernel when its holder dies. Without it (macOS) a slot is a symlink naming its holder ("<pid>|<start>|<worktree>"),
# made atomically by ln -s and reclaimed once that pid is gone or belongs to a process started at another time (reuse).
# CI (CI=true; each runner is alone): no limit unless CHECK_MAX_SUITES or CHECK_MAX_BUILDS is set. 0: no limit.

lock_init() { # LOCK_DIR, LOCK_IMPL, LOCK_SUITES, LOCK_BUILDS (0: no limit), LOCK_WHO; exit 2 on a bad setting
  _lc=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4); _lc=$((_lc / 4)); [ $_lc -ge 1 ] || _lc=1; [ $_lc -le 6 ] || _lc=6
  case "${CI:-}" in ''|false|0) _lci="";; *) _lci=1;; esac
  if [ -n "$_lci" ] && [ -z "${CHECK_MAX_SUITES:-}" ] && [ -z "${CHECK_MAX_BUILDS:-}" ]; then LOCK_SUITES=0; LOCK_BUILDS=0
  else LOCK_SUITES=${CHECK_MAX_SUITES:-2}; LOCK_BUILDS=${CHECK_MAX_BUILDS:-$_lc}; fi
  for _lv in "CHECK_MAX_SUITES=$LOCK_SUITES" "CHECK_MAX_BUILDS=$LOCK_BUILDS"; do
    case "${_lv#*=}" in ''|*[!0-9]*) echo "$_lv: want a number of slots (0: no limit)" >&2; exit 2;; esac
  done
  LOCK_DIR=${CHECK_LOCK_DIR:-$HOME/.cache/agentglass-check}
  LOCK_IMPL=${CHECK_LOCK_IMPL:-}; [ -n "$LOCK_IMPL" ] || { command -v flock >/dev/null 2>&1 && LOCK_IMPL="flock" || LOCK_IMPL="link"; }
  LOCK_WHO=${CHECK_LOCK_WHO:-$(pwd)}; case "$LOCK_WHO" in "$HOME"/*) LOCK_WHO="~${LOCK_WHO#"$HOME"}";; esac
  LOCK_HELD=""
}

lock_start() { LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//'; } # a pid's start time
lock_alive() { # lock_alive <pid|start|who>: that process still runs (same pid, same start time: not a reused pid)
  _lp=${1%%|*}; _ls=${1#*|}; _ls=${_ls%%|*}
  case "$_lp" in ''|*[!0-9]*) return 1;; esac
  kill -0 "$_lp" 2>/dev/null || ps -p "$_lp" >/dev/null 2>&1 || return 1 # (ps: another user's process, EPERM)
  [ -z "$_ls" ] || [ "$(lock_start "$_lp")" = "$_ls" ]
}
lock_holder() { # lock_holder <slot>: its holder's worktree (empty when free)
  if [ -L "$1" ]; then _lh=$(readlink "$1" 2>/dev/null); else _lh=$(cat "$1" 2>/dev/null); fi
  [ -z "$_lh" ] || printf '%s\n' "${_lh#*|*|}"
}

slot_try() { # slot_try <slot> <token>: take that slot now, fail (1: it is held), or 2: it cannot be taken at all
  # a slot the other implementation left (a file system that changed, CHECK_LOCK_IMPL): held while its holder lives,
  # else removed; never a slot neither can take
  if [ "$LOCK_IMPL" = flock ] && [ -L "$1" ]; then ! lock_alive "$(readlink "$1")" || return 1; rm -f "$1"; fi
  if [ "$LOCK_IMPL" = link ] && [ -f "$1" ] && ! [ -L "$1" ]; then
    ! { command -v flock >/dev/null 2>&1 && ! flock -n "$1" true 2>/dev/null; } || return 1; rm -f "$1"
  fi
  if [ "$LOCK_IMPL" = flock ]; then # fd 9 holds it; >> does not truncate a holder's token
    { command exec 9>>"$1"; } 2>/dev/null || return 2 # (command: a failed exec must not end the shell)
    if flock -n 9; then printf '%s\n' "$2" > "$1"; LOCK_HELD=$1; return 0; fi
    exec 9>&-; return 1
  fi
  ln -s "$2" "$1" 2>/dev/null && { LOCK_HELD=$1; return 0; }
  _lo=$(readlink "$1" 2>/dev/null) || return 1 # freed meanwhile: the next round takes it
  ! lock_alive "$_lo" || return 1
  # stale: move it aside (atomic: one reclaimer wins), delete it only if it is still the stale one; else it was
  # reclaimed and taken by another meanwhile: put that one back (if a third took the slot in that instant, the put-back
  # fails and that run has one extra holder: a bound of one, for one run, on macOS only)
  _lg="$LOCK_DIR/.reap.$$"; rm -f "$_lg"; mv "$1" "$_lg" 2>/dev/null || return 1
  _ln=$(readlink "$_lg" 2>/dev/null); rm -f "$_lg"
  if [ "$_ln" != "$_lo" ]; then ln -s "$_ln" "$1" 2>/dev/null; return 1; fi
  ln -s "$2" "$1" 2>/dev/null && { LOCK_HELD=$1; return 0; }
  return 1
}

# slot_take <suite|build> <max>: wait for a free slot of that kind and take it (nothing with max 0); a waiting suite
# says so once on stderr, naming the holders. LOCK_WAITED: 1 when it had to wait
slot_take() {
  [ "$2" -gt 0 ] || return 0
  if ! mkdir -p "$LOCK_DIR" 2>/dev/null || ! [ -w "$LOCK_DIR" ]; then # never wait forever on slots that cannot exist
    [ "$1" != suite ] || echo "check slots: cannot write $LOCK_DIR — running without the machine-wide limit" >&2; return 0
  fi
  chmod 700 "$LOCK_DIR" 2>/dev/null || true
  # a file system without flock (an NFS home without lockd): symlinks instead. A shared lock on a file no one locks
  # exclusively fails only there, so every process on that file system makes the same choice
  if [ "$LOCK_IMPL" = flock ] && ! { command exec 8>>"$LOCK_DIR/.probe" && flock -n -s 8; } 2>/dev/null; then LOCK_IMPL=link; fi
  exec 8>&-
  LOCK_TOK="$$|$(lock_start $$)|$LOCK_WHO"; _lsaid=""; LOCK_WAITED=""
  while :; do
    _li=1; _lnum=0; _lwho=""
    while [ $_li -le "$2" ]; do
      _lr=0; slot_try "$LOCK_DIR/$1.$_li" "$LOCK_TOK" || _lr=$?
      [ $_lr != 0 ] || return 0
      if [ $_lr = 2 ]; then # never wait forever on a slot that cannot be taken
        [ "$1" != suite ] || echo "check slots: cannot open $LOCK_DIR/$1.$_li — running without the machine-wide limit" >&2; return 0
      fi
      _lh=$(lock_holder "$LOCK_DIR/$1.$_li"); [ -z "$_lh" ] || { _lnum=$((_lnum + 1)); _lwho="$_lwho, $_lh"; }
      _li=$((_li + 1))
    done
    if [ "$1" = suite ] && [ -z "$_lsaid" ]; then echo "waiting for a check slot ($_lnum running: ${_lwho#, })" >&2; _lsaid=1; fi
    LOCK_WAITED=1
    sleep "${CHECK_LOCK_POLL:-0.5}"
  done
}
slot_drop() { # frees the slot this process holds
  [ -n "$LOCK_HELD" ] || return 0
  if [ "$LOCK_IMPL" = flock ]; then exec 9>&-
  elif [ "$(readlink "$LOCK_HELD" 2>/dev/null)" = "$LOCK_TOK" ]; then rm -f "$LOCK_HELD"; fi
  LOCK_HELD=""
}

case "${0##*/}" in check-lock.sh) ;; *) return 0 2>/dev/null || exit 0;; esac # sourced: functions only

case "${1:-}" in
  run)
    [ $# -ge 3 ] || { echo "usage: sh scripts/check-lock.sh run <suite|build> <cmd>…" >&2; exit 2; }
    k=$2; shift 2
    lock_init
    case "$k" in
      suite) max=$LOCK_SUITES; [ -z "${CHECK_LOCK_SUITE_HELD:-}" ] || max=0; CHECK_LOCK_SUITE_HELD=1 ;;
      build) max=$LOCK_BUILDS; [ -z "${CHECK_LOCK_IN_BUILD:-}" ] || max=0; CHECK_LOCK_IN_BUILD=1 ;;
      *) echo "check-lock.sh run: want suite or build, not '$k'" >&2; exit 2 ;;
    esac
    export CHECK_LOCK_SUITE_HELD CHECK_LOCK_IN_BUILD 2>/dev/null
    trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; slot_drop' EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
    t0=$(date +%s); LOCK_WAITED=""; slot_take "$k" "$max"
    [ -z "$LOCK_WAITED" ] || [ -z "${CHECK_LOCK_WAITS:-}" ] || echo "$k $(($(date +%s) - t0))" >> "$CHECK_LOCK_WAITS"
    rc=0; "$@" 9>&- || rc=$? # the command does not inherit the lock: a daemon it leaves behind cannot hold the slot
    exit $rc ;;
  status)
    lock_init; echo "check slots in $LOCK_DIR ($LOCK_IMPL): $LOCK_SUITES suites, $LOCK_BUILDS builds (0: no limit)"
    for f in "$LOCK_DIR"/suite.* "$LOCK_DIR"/build.*; do
      [ -e "$f" ] || [ -L "$f" ] || continue
      if [ -L "$f" ]; then h=$(readlink "$f"); lock_alive "$h" || continue
      else ! flock -n "$f" true 2>/dev/null || continue; h=$(cat "$f"); fi
      echo "${f##*/} pid ${h%%|*}: ${h#*|*|}"
    done ;;
  *) echo "usage: sh scripts/check-lock.sh run <suite|build> <cmd>… | status" >&2; exit 2 ;;
esac
