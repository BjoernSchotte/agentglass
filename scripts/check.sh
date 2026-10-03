#!/bin/sh
# build + run every self-check (src/**/*.check.ts) and shell test (scripts/*.test.sh) in parallel; exit 1 if any fails
# CHECK_JOBS: parallel jobs (default: CPU count). CHECK_SCRIPTC_FLAGS: check build flags (default: --optimization dev, -O0
# with cached object shards: same program behavior, about half the compile time; empty for -O2; also used for the tests'
# own builds). The shell tests share one agentglass, built here once, in parallel with the checks: AGENTGLASS_BIN uses a
# prebuilt one instead; else AGENTGLASS_OUT (default .scriptc/check/agentglass) with CHECK_BIN_FLAGS (default: the check
# flags; CI: empty, the release build, which the tests then run and CI smoke-tests after).
set -e
cd "$(dirname "$0")/.."

# one job (internal): bin, check:<file> or test:<file>; writes $CHECK_OUT/<id>.status (0, an exit code, or "build") and $CHECK_OUT/<id>.log
if [ "${1:-}" = --job ]; then
  job=$2; id=$(printf %s "$job" | tr '/:.' '___'); log="$CHECK_OUT/$id.log"; rc=0
  case "$job" in
    bin) scriptc build $CHECK_BIN_FLAGS src/main.ts -o "$AGENTGLASS_BIN" >"$log" 2>&1 || rc=$?
         echo $rc > "$CHECK_OUT/bin.done" ;;
    check:*) f=${job#check:}; c="$PWD/.scriptc/check/$id" # scriptc keys its cache on the output path: keep it stable
         if ! scriptc build $CHECK_SCRIPTC_FLAGS "$f" -o "$c" >"$log" 2>&1; then rc=build
         else AGENTGLASS_RULES=/nonexistent AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme "$c" >"$log" 2>&1 || rc=$?; fi
         rm -rf "$c" "$c".* ;; # a cache hit doesn't need the old executable
    test:*) f=${job#test:}
         if grep -q AGENTGLASS_BIN "$f"; then # uses the shared binary: wait for the bin job (queued first, so already running)
           while [ ! -s "$CHECK_OUT/bin.done" ]; do sleep 0.2; done
           [ "$(cat "$CHECK_OUT/bin.done")" = 0 ] || { echo "skipped: agentglass build failed" > "$log"; rc=1; }
         fi
         [ $rc != 0 ] || sh "$f" >"$log" 2>&1 || rc=$? ;;
  esac
  echo $rc > "$CHECK_OUT/$id.status"; exit 0
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
mkdir -p .scriptc/check
checks=$(find src -name '*.check.ts' | sort); tests=$(find scripts -name '*.test.sh' | sort)
if [ -n "${AGENTGLASS_BIN:-}" ]; then
  [ -f "$AGENTGLASS_BIN" ] && [ -x "$AGENTGLASS_BIN" ] || { echo "AGENTGLASS_BIN=$AGENTGLASS_BIN is not an executable" >&2; exit 1; }
  AGENTGLASS_BIN=$(cd "$(dirname "$AGENTGLASS_BIN")" && pwd)/$(basename "$AGENTGLASS_BIN"); echo 0 > "$CHECK_OUT/bin.done"; bin=""
else # a stable path: scriptc keys its cache on it
  AGENTGLASS_BIN=${AGENTGLASS_OUT:-.scriptc/check/agentglass}; case "$AGENTGLASS_BIN" in /*) ;; *) AGENTGLASS_BIN="$PWD/$AGENTGLASS_BIN";; esac; bin=bin
fi
export AGENTGLASS_BIN

# queue order: the shared binary first, then the tests that don't wait for it (the long versioned builds among them),
# then the checks, then the tests that use the binary; xargs starts jobs in queue order
nobin=""; usebin=""
for f in $tests; do if grep -q AGENTGLASS_BIN "$f"; then usebin="$usebin test:$f"; else nobin="$nobin test:$f"; fi; done
{ [ -z "$bin" ] || echo bin; for j in $nobin; do echo "$j"; done; for f in $checks; do echo "check:$f"; done; for j in $usebin; do echo "$j"; done; } \
  | xargs -n 1 -P "$jobs" sh scripts/check.sh --job

# report in a fixed order (checks, then tests), whatever order the jobs finished in
fail=0
report() { # report <job> <file>
  id=$(printf %s "$1" | tr '/:.' '___'); rc=$(cat "$CHECK_OUT/$id.status" 2>/dev/null || echo missing)
  if [ "$rc" = 0 ]; then echo "ok   $2: $(tail -1 "$CHECK_OUT/$id.log")"
  elif [ "$rc" = build ]; then echo "BUILD FAIL $2"; cat "$CHECK_OUT/$id.log"; fail=1
  else echo "FAIL $2 (exit $rc)"; cat "$CHECK_OUT/$id.log" 2>/dev/null || true; fail=1; fi
}
if [ -n "$bin" ] && [ "$(cat "$CHECK_OUT/bin.done" 2>/dev/null)" != 0 ]; then echo "BUILD FAIL src/main.ts"; cat "$CHECK_OUT/bin.log"; fail=1; fi
for f in $checks; do report "check:$f" "$f"; done
for f in $tests; do report "test:$f" "$f"; done
echo "$(echo "$checks" | wc -l | tr -d ' ') checks, $(echo "$tests" | wc -l | tr -d ' ') tests, $jobs jobs, $(($(date +%s) - start)) s"
exit $fail
