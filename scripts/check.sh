#!/bin/sh
# build + run every self-check (src/**/*.check.ts) and shell test (scripts/*.test.sh) in parallel; exit 1 if any fails
# CHECK_JOBS: parallel jobs (default: CPU count). CHECK_SCRIPTC_FLAGS: check build flags (default: --optimization dev, -O0
# with cached object shards: same program behavior, about half the compile time; empty for -O2; also used for the tests'
# own builds). A check with a "// check: timing" line (a timing budget) builds -O2 and runs alone after the others.
# The shell tests share one agentglass, built here once, in parallel with the checks: AGENTGLASS_BIN uses a prebuilt one
# instead; else AGENTGLASS_OUT (default .scriptc/check/agentglass) with CHECK_BIN_FLAGS (default: the check flags; CI:
# empty, the release build, which the tests then run and CI smoke-tests after).
# CHECK_SHARD=<i>/<n> runs only shard i of n (CI splits each OS across runners): shard 1 takes the shared binary and the
# tests that use it, the rest go round-robin, the tests with their own builds first so they spread.
set -e
cd "$(dirname "$0")/.."

run_check() { # run_check <id> <executable> <log>: sets rc
  # hermetic: a fresh temp HOME/XDG per check and no agent-dir or agentglass path overrides from the caller, so no check
  # can read or write the user's real home (sessions, ~/.agentglass config, cache, run dir, palette, theme)
  h="$CHECK_OUT/$1.home"; mkdir -p "$h"; rc=0
  env -u GEMINI_CLI_HOME -u OPENCODE_DB -u PI_CODING_AGENT_DIR -u PI_CODING_AGENT_SESSION_DIR -u AGENTGLASS_CACHE_DIR \
    -u AGENTGLASS_CONFIG -u AGENTGLASS_RUN_DIR -u AGENTGLASS_PALETTE_FILE -u AGENTGLASS_OTLP_DIR -u AGENTGLASS_THEME \
    HOME="$h" XDG_CONFIG_HOME="$h/.config" XDG_DATA_HOME="$h/.local/share" XDG_STATE_HOME="$h/.local/state" \
    XDG_CACHE_HOME="$h/.cache" AGENTGLASS_HERMETIC=1 \
    AGENTGLASS_RULES=/nonexistent AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme "$2" >"$3" 2>&1 || rc=$?
  rm -rf "$h"
}

# one job (internal): bin, check:<file> or test:<file>; writes $CHECK_OUT/<id>.status ("<rc> <seconds>", rc 0, an exit
# code, "build", or "deferred": a timing check, built, to run alone after the pool) and $CHECK_OUT/<id>.log
if [ "${1:-}" = --job ]; then
  job=$2; id=$(printf %s "$job" | tr '/:.' '___'); log="$CHECK_OUT/$id.log"; rc=0; t0=$(date +%s)
  case "$job" in
    bin) scriptc build $CHECK_BIN_FLAGS src/main.ts -o "$AGENTGLASS_BIN" >"$log" 2>&1 || rc=$?
         echo $rc > "$CHECK_OUT/bin.done" ;;
    check:*) f=${job#check:} # scriptc keys its cache on the output path: keep it stable. One directory per check: scriptc
         d="$PWD/.scriptc/check/$id"; mkdir -p "$d" # writes <source basename>.ll beside it, and basenames repeat
         fl=$CHECK_SCRIPTC_FLAGS; timing=""; if grep -q '^// check: timing' "$f"; then fl=""; timing=1; fi
         if ! scriptc build $fl "$f" -o "$d/c" >"$log" 2>&1; then rc=build
         elif [ -n "$timing" ]; then rc=deferred # runs after the pool, alone
         else run_check "$id" "$d/c" "$log"; fi
         [ "$rc" = deferred ] || rm -rf "$d" ;; # a cache hit doesn't need the old executable
    test:*) f=${job#test:}
         if grep -q AGENTGLASS_BIN "$f"; then # uses the shared binary: wait for the bin job (queued first, so already running)
           while [ ! -s "$CHECK_OUT/bin.done" ]; do sleep 0.2; done
           [ "$(cat "$CHECK_OUT/bin.done")" = 0 ] || { echo "skipped: agentglass build failed" > "$log"; rc=1; }
         fi
         # hermetic via their own temp HOME: no agentglass path overrides from the caller
         [ $rc != 0 ] || env -u AGENTGLASS_CONFIG -u AGENTGLASS_RULES -u AGENTGLASS_CACHE_DIR sh "$f" >"$log" 2>&1 || rc=$? ;;
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
CHECK_SCRIPTC_FLAGS=${CHECK_SCRIPTC_FLAGS---optimization dev}
CHECK_BIN_FLAGS="${SCRIPTC_FLAGS:-} ${CHECK_BIN_FLAGS-$CHECK_SCRIPTC_FLAGS}"
SCRIPTC_FLAGS="${SCRIPTC_FLAGS:-} $CHECK_SCRIPTC_FLAGS" # the tests' own builds: build.sh honors SCRIPTC_FLAGS
export CHECK_OUT CHECK_SCRIPTC_FLAGS CHECK_BIN_FLAGS SCRIPTC_FLAGS PATH
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

# queue order: the shared binary first, then the tests with their own builds, the other tests that don't wait for the
# binary, the checks, and the tests that use the binary; xargs starts jobs in queue order
own=""; nobin=""; usebin=""
for f in $tests; do
  if grep -q AGENTGLASS_BIN "$f"; then usebin="$usebin test:$f"
  elif grep -q 'build\.sh' "$f"; then own="test:$f $own" # whole-agentglass builds: the heaviest, first
  elif grep -q 'scriptc build' "$f"; then own="$own test:$f"
  else nobin="$nobin test:$f"; fi
done
k=1; mine="" # this shard's jobs: shard 1 has the binary and its users, the rest round-robin from shard 2
for j in $own $nobin $(for f in $checks; do echo "check:$f"; done); do
  [ $((k % sn + 1)) != "$si" ] || mine="$mine $j"; k=$((k + 1))
done
if [ "$si" = 1 ]; then mine="$mine $usebin"; else bin=""; usebin=""; fi
for j in $mine; do echo "$j"; done > "$CHECK_OUT/queue"
{ [ -z "$bin" ] || echo bin; cat "$CHECK_OUT/queue"; } | xargs -n 1 -P "$jobs" sh scripts/check.sh --job
for j in $(grep '^check:' "$CHECK_OUT/queue"); do # the timing checks, one at a time on an idle machine
  id=$(printf %s "$j" | tr '/:.' '___'); set -- $(cat "$CHECK_OUT/$id.status")
  if [ "$1" = deferred ]; then
    t0=$(date +%s); run_check "$id" "$PWD/.scriptc/check/$id/c" "$CHECK_OUT/$id.log"; rm -rf ".scriptc/check/$id"
    echo "$rc $(($2 + $(date +%s) - t0))" > "$CHECK_OUT/$id.status"
  fi
done

# report in a fixed order (checks, then tests), whatever order the jobs finished in
fail=0
report() { # report <job> <file>
  id=$(printf %s "$1" | tr '/:.' '___'); set -- "$1" "$2" $(cat "$CHECK_OUT/$id.status" 2>/dev/null || echo missing "?"); rc=$3
  if [ "$rc" = 0 ]; then echo "ok   $2 ($4 s): $(tail -1 "$CHECK_OUT/$id.log")"
  elif [ "$rc" = build ]; then echo "BUILD FAIL $2 ($4 s)"; cat "$CHECK_OUT/$id.log"; fail=1
  else echo "FAIL $2 (exit $rc, $4 s)"; cat "$CHECK_OUT/$id.log" 2>/dev/null || true; fail=1; fi
}
if [ -n "$bin" ]; then
  if [ "$(cat "$CHECK_OUT/bin.done" 2>/dev/null)" = 0 ]; then echo "ok   src/main.ts ($(cut -d' ' -f2 "$CHECK_OUT/bin.status") s): built $AGENTGLASS_BIN"
  else echo "BUILD FAIL src/main.ts"; cat "$CHECK_OUT/bin.log"; fail=1; fi
fi
for f in $checks; do if grep -qxF "check:$f" "$CHECK_OUT/queue"; then report "check:$f" "$f"; fi; done
for f in $tests; do if grep -qxF "test:$f" "$CHECK_OUT/queue"; then report "test:$f" "$f"; fi; done
echo "$(grep -c '^check:' "$CHECK_OUT/queue") checks, $(grep -c '^test:' "$CHECK_OUT/queue") tests (shard $si/$sn), $jobs jobs, $(($(date +%s) - start)) s"
exit $fail
