#!/bin/sh
# build + run every self-check (src/**/*.check.ts) and shell test (scripts/*.test.sh) in parallel; exit 1 if any fails
# CHECK_JOBS: parallel jobs (default: CPU count). CHECK_SCRIPTC_FLAGS: check build flags (default: --optimization dev
# --strip: -O0 with cached object shards, same program behavior, about half the compile time; --strip skips macOS's
# dsymutil; empty for -O2; also used for the tests' own builds). A check with a "// check: timing" line (a timing budget) builds -O2 and runs alone after the others;
# a shell test with a "# check: timing" line (a latency bound) runs alone after the others too.
# On macOS CHECK_FFI (--ffi src/platform/darwin/ffi.json: the libproc bindings) goes into the bin and release builds and
# into every check with a "// check: ffi" line, those built with --backend c too (the darwin-x64 release's backend);
# libproc.c is also compiled once with -Wall -Wextra -Werror (job cc:<file>).
# The shell tests share one agentglass, built here once, in parallel with the checks: AGENTGLASS_BIN uses a prebuilt one
# instead; else AGENTGLASS_OUT (default .scriptc/check/agentglass) with CHECK_BIN_FLAGS (default: the check flags).
# CHECK_RELEASE_OUT: also build the release binary (-O2, as shipped) there and smoke-test it, as one more job.
# CHECK_SHARD=<i>/<n> runs only shard i of n (CI splits each OS across runners), balanced by scripts/check-plan.mjs;
# shard 1 takes the shared binary and the tests that use it.
set -e
cd "$(dirname "$0")/.."
# never reach the developer's real herdr (checks run inside herdr panes): its variables are dropped for every job
HERDR_UNSET="-u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID -u HERDR_SOCKET_PATH -u HERDR_BIN_PATH -u HERDR_SESSION -u HERDR_PLUGIN_ID -u AGENTGLASS_HERDR_SOCKET"

# limit S cmd…: run cmd with stdin from /dev/null, kill it (and its children) after S seconds: a hang fails fast
limit() {
  s=$1; shift
  "$@" </dev/null & p=$!
  ( sleep "$s"; kill -0 "$p" 2>/dev/null || exit 0; echo "TIMEOUT after ${s}s: $*"; pkill -TERM -P "$p" 2>/dev/null; kill -TERM "$p" 2>/dev/null ) 2>/dev/null & w=$! # quiet: killing its sleep must not print "Terminated" into the log
  wait "$p"; rc=$?
  pkill -P "$w" 2>/dev/null; wait "$w" 2>/dev/null # its sleep ends, the watchdog sees cmd gone and exits
  return $rc
}

run_test() { limit 600 env $HERDR_UNSET -u AGENTGLASS_CONFIG -u AGENTGLASS_RULES -u AGENTGLASS_CACHE_DIR -u AGENTGLASS_PRICES -u AGENTGLASS_FLEET_DIR -u AGENTGLASS_SSH -u AGENTGLASS_FLEET AGENTGLASS_HERDR=off sh "$1" >"$2" 2>&1; } # run_test <file> <log>
run_check() { # run_check <id> <executable> <log>: sets rc
  # hermetic: a fresh temp HOME/XDG per check and no agent-dir or agentglass path overrides from the caller, so no check
  # can read or write the user's real home (sessions, ~/.agentglass config, cache, run dir, palette, theme)
  h="$CHECK_OUT/$1.home"; mkdir -p "$h"; rc=0
  # (herdr: no HERDR_* of the developer's own pane and herdr off — a herdr check opts in with a fake binary and socket)
  limit 300 env $HERDR_UNSET -u GEMINI_CLI_HOME -u OPENCODE_DB -u PI_CODING_AGENT_DIR -u PI_CODING_AGENT_SESSION_DIR -u AGENTGLASS_CACHE_DIR \
    -u AGENTGLASS_CONFIG -u AGENTGLASS_RUN_DIR -u AGENTGLASS_PALETTE_FILE -u AGENTGLASS_OTLP_DIR -u AGENTGLASS_THEME -u AGENTGLASS_THEME_FILE -u AGENTGLASS_PRICES -u AGENTGLASS_FLEET_DIR -u AGENTGLASS_SSH -u AGENTGLASS_FLEET \
    AGENTGLASS_HERDR=off HOME="$h" XDG_CONFIG_HOME="$h/.config" XDG_DATA_HOME="$h/.local/share" XDG_STATE_HOME="$h/.local/state" \
    XDG_CACHE_HOME="$h/.cache" AGENTGLASS_HERMETIC=1 \
    AGENTGLASS_RULES=/nonexistent AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme "$2" >"$3" 2>&1 || rc=$?
  rm -rf "$h"
}

# summary <log>: the job's own last line; shell job-status lines a killed child leaves after it ("Terminated", bash's
# "x.sh: line 9: 123 Terminated  sleep 9", "Killed") and blank lines are skipped (the last line wins if all are noise)
summary() {
  awk '{ l = $0; sub(/^.*: line [0-9]+: +[0-9]+ +/, "", l) }
       !/^[[:space:]]*$/ && l !~ /^(Terminated|Killed|Hangup|Alarm clock|Interrupt)([: ].*)?$/ { s = $0 }
       NF { last = $0 } END { print (s != "" ? s : last) }' "$1"
}
if [ "${1:-}" = --summary ]; then summary "$2"; exit 0; fi

# one job (internal): bin, check:<file> or test:<file>; writes $CHECK_OUT/<id>.status ("<rc> <seconds>", rc 0, an exit
# code, "build", or "deferred": a timing check, built, to run alone after the pool) and $CHECK_OUT/<id>.log
if [ "${1:-}" = --job ]; then
  job=$2; id=$(printf %s "$job" | tr '/:.' '___'); log="$CHECK_OUT/$id.log"; rc=0; t0=$(date +%s)
  case "$job" in
    bin) scriptc build $CHECK_BIN_FLAGS $CHECK_FFI src/main.ts -o "$AGENTGLASS_BIN" >"$log" 2>&1 || rc=$?
         echo $rc > "$CHECK_OUT/bin.done" ;;
    release) # the release build (-O2, as shipped) and a smoke test of it
         { scriptc build $RELEASE_FLAGS $CHECK_FFI src/main.ts -o "$CHECK_RELEASE_OUT" && h="$CHECK_OUT/release.home" && mkdir -p "$h" &&
           HOME="$h" XDG_CONFIG_HOME="$h/.config" XDG_STATE_HOME="$h/.local/state" XDG_CACHE_HOME="$h/.cache" sh -c \
             '"$1" --version && "$1" --version --json && "$1" --json --limit 1 >/dev/null && echo "release build: smoke test ok"' _ "$CHECK_RELEASE_OUT" &&
           { [ -z "$CHECK_FFI" ] || { nm -u "$CHECK_RELEASE_OUT" | grep -q '_proc_listallpids' && echo "release build: libproc bound"; }; }
         } >"$log" 2>&1 || rc=$? ;;
    check:*) f=${job#check:} # scriptc keys its cache on the output path: keep it stable. One directory per check: scriptc
         d="$PWD/.scriptc/check/$id"; mkdir -p "$d" # writes <source basename>.ll beside it, and basenames repeat
         fl=$CHECK_SCRIPTC_FLAGS; timing=""; if grep -q '^// check: timing' "$f"; then fl=""; timing=1; fi
         if [ -n "$CHECK_FFI" ] && grep -q '^// check: ffi' "$f"; then fl="$fl $CHECK_FFI --backend c"; fi
         if ! scriptc build $fl "$f" -o "$d/c" >"$log" 2>&1; then rc=build
         elif [ -n "$timing" ]; then rc=deferred # runs after the pool, alone
         else run_check "$id" "$d/c" "$log"; fi
         [ "$rc" = deferred ] || rm -rf "$d" ;; # a cache hit doesn't need the old executable
    cc:*) f=${job#cc:} # the FFI's C file, warnings as errors
         { cc -fsyntax-only -Wall -Wextra -Werror "$f" && echo "$f: no warnings"; } >"$log" 2>&1 || rc=$? ;;
    test:*) f=${job#test:}
         if grep -q AGENTGLASS_BIN "$f"; then # uses the shared binary: wait for the bin job (queued first, so already running)
           while [ ! -s "$CHECK_OUT/bin.done" ]; do sleep 0.2; done
           [ "$(cat "$CHECK_OUT/bin.done")" = 0 ] || { echo "skipped: agentglass build failed" > "$log"; rc=1; }
         fi
         # hermetic via their own temp HOME: no agentglass path overrides from the caller
         if [ $rc = 0 ] && grep -q '^# check: timing' "$f"; then rc=deferred # runs after the pool, alone
         else [ $rc != 0 ] || run_test "$f" "$log" || rc=$?; fi ;;
  esac
  echo "$rc $(($(date +%s) - t0))" > "$CHECK_OUT/$id.status"; exit 0
fi

. ./scripts/toolchain.sh
start=$(date +%s)
# once, before any build (no job rewrites src/build-info.ts); the commit date, not now, keeps it byte-identical across
# runs on one commit, so unchanged checks are scriptc cache hits
AGENTGLASS_BUILD_DATE=${AGENTGLASS_BUILD_DATE:-$(TZ=UTC git log -1 --date=format-local:%Y-%m-%dT%H:%M:%SZ --format=%cd 2>/dev/null || true)}
export AGENTGLASS_BUILD_DATE; sh scripts/build-info.sh
jobs=${CHECK_JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}
CHECK_OUT=$(mktemp -d); trap 'rm -rf "$CHECK_OUT"' EXIT
CHECK_SCRIPTC_FLAGS=${CHECK_SCRIPTC_FLAGS---optimization dev --strip}
RELEASE_FLAGS="${SCRIPTC_FLAGS:-}"; CHECK_BIN_FLAGS="${SCRIPTC_FLAGS:-} ${CHECK_BIN_FLAGS-$CHECK_SCRIPTC_FLAGS}"
SCRIPTC_FLAGS="${SCRIPTC_FLAGS:-} $CHECK_SCRIPTC_FLAGS" # the tests' own builds: build.sh honors SCRIPTC_FLAGS
CHECK_FFI=""; if [ "$(uname -s)" = Darwin ] && [ -f src/platform/darwin/ffi.json ]; then CHECK_FFI="--ffi $PWD/src/platform/darwin/ffi.json"; fi
export CHECK_OUT CHECK_SCRIPTC_FLAGS CHECK_BIN_FLAGS RELEASE_FLAGS SCRIPTC_FLAGS CHECK_FFI PATH
rm -rf .scriptc/check; mkdir -p .scriptc/check
checks=$(find src -name '*.check.ts' | sort); tests=$(find scripts -name '*.test.sh' | sort)
shard=${CHECK_SHARD:-1/1}; si=${shard%/*}; sn=${shard#*/}
case "$si/$sn" in *[!0-9/]*|/*|*/) echo "CHECK_SHARD=$shard: want <i>/<n>" >&2; exit 1;; esac
[ "$si" -ge 1 ] && [ "$si" -le "$sn" ] || { echo "CHECK_SHARD=$shard: want 1 <= i <= n" >&2; exit 1; }
if [ -n "${AGENTGLASS_BIN:-}" ]; then
  [ -f "$AGENTGLASS_BIN" ] && [ -x "$AGENTGLASS_BIN" ] || { echo "AGENTGLASS_BIN=$AGENTGLASS_BIN is not an executable" >&2; exit 1; }
  AGENTGLASS_BIN=$(cd "$(dirname "$AGENTGLASS_BIN")" && pwd)/$(basename "$AGENTGLASS_BIN"); echo 0 > "$CHECK_OUT/bin.done"; bin=""
else # a stable path: scriptc keys its cache on it
  AGENTGLASS_BIN=${AGENTGLASS_OUT:-.scriptc/check/agentglass}; case "$AGENTGLASS_BIN" in /*) ;; *) AGENTGLASS_BIN="$PWD/$AGENTGLASS_BIN";; esac; bin=bin
fi
export AGENTGLASS_BIN

# this shard's jobs, heaviest first (scripts/check-plan.mjs); xargs starts them in that order, the shared binary first
if [ -n "${CHECK_RELEASE_OUT:-}" ]; then
  case "$CHECK_RELEASE_OUT" in /*) ;; *) CHECK_RELEASE_OUT="$PWD/$CHECK_RELEASE_OUT";; esac; export CHECK_RELEASE_OUT
fi
all="$([ -z "$bin" ] || echo bin) $([ -z "${CHECK_RELEASE_OUT:-}" ] || echo release)"
all="$all $(for f in $tests; do echo "test:$f"; done) $(for f in $checks; do echo "check:$f"; done)"
[ -z "$CHECK_FFI" ] || all="$all cc:src/platform/darwin/libproc.c"
node scripts/check-plan.mjs "$si" "$sn" $all > "$CHECK_OUT/queue"
grep -qx bin "$CHECK_OUT/queue" || bin="" # on another shard
grep -qx release "$CHECK_OUT/queue" && release=1 || release=""
xargs -n 1 -P "$jobs" sh scripts/check.sh --job < "$CHECK_OUT/queue"
for j in $(grep -E '^(check|test):' "$CHECK_OUT/queue"); do # the timing checks and tests, one at a time on an idle machine
  id=$(printf %s "$j" | tr '/:.' '___'); set -- $(cat "$CHECK_OUT/$id.status")
  if [ "$1" = deferred ]; then
    t0=$(date +%s)
    case "$j" in
      check:*) run_check "$id" "$PWD/.scriptc/check/$id/c" "$CHECK_OUT/$id.log"; rm -rf ".scriptc/check/$id" ;;
      test:*) rc=0; run_test "${j#test:}" "$CHECK_OUT/$id.log" || rc=$? ;;
    esac
    echo "$rc $(($2 + $(date +%s) - t0))" > "$CHECK_OUT/$id.status"
  fi
done

# report in a fixed order (checks, then tests), whatever order the jobs finished in
fail=0
report() { # report <job> <file>
  id=$(printf %s "$1" | tr '/:.' '___'); set -- "$1" "$2" $(cat "$CHECK_OUT/$id.status" 2>/dev/null || echo missing "?"); rc=$3
  if [ "$rc" = 0 ]; then echo "ok   $2 ($4 s): $(summary "$CHECK_OUT/$id.log")"
  elif [ "$rc" = build ]; then echo "BUILD FAIL $2 ($4 s)"; cat "$CHECK_OUT/$id.log"; fail=1
  else echo "FAIL $2 (exit $rc, $4 s)"; cat "$CHECK_OUT/$id.log" 2>/dev/null || true; fail=1; fi
}
if [ -n "$bin" ]; then
  if [ "$(cat "$CHECK_OUT/bin.done" 2>/dev/null)" = 0 ]; then echo "ok   src/main.ts ($(cut -d' ' -f2 "$CHECK_OUT/bin.status") s): built $AGENTGLASS_BIN"
  else echo "BUILD FAIL src/main.ts"; cat "$CHECK_OUT/bin.log"; fail=1; fi
fi
if [ -n "$release" ]; then report release "src/main.ts -O2 -> $CHECK_RELEASE_OUT"; fi
for f in $checks; do if grep -qxF "check:$f" "$CHECK_OUT/queue"; then report "check:$f" "$f"; fi; done
for j in $(grep '^cc:' "$CHECK_OUT/queue"); do report "$j" "${j#cc:} (cc -Wall -Wextra -Werror)"; done
for f in $tests; do if grep -qxF "test:$f" "$CHECK_OUT/queue"; then report "test:$f" "$f"; fi; done
echo "$(grep -c '^check:' "$CHECK_OUT/queue") checks, $(grep -c '^test:' "$CHECK_OUT/queue") tests (shard $si/$sn), $jobs jobs, $(($(date +%s) - start)) s"
exit $fail
