#!/bin/sh
# check.sh --changed runs exactly the checks and tests a change reaches, never fewer: the planner (check-plan.mjs
# --changed) over this repo's real jobs for typical changes, invariants over every job, and check.sh --changed
# --dry-run end to end in a throwaway git copy (committed, uncommitted and untracked changes): sh scripts/check-changed.test.sh
cd "$(dirname "$0")/.."
here=$PWD; t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail=0
bad() { echo "FAIL $*"; fail=1; }
checks=$(find src -name '*.check.ts' | sort); tests=$(find scripts -name '*.test.sh' | sort)
all="bin release $(for f in $tests; do echo "test:$f"; done) $(for f in $checks; do echo "check:$f"; done)"
# ("build"".sh" is split like the binary variable: a test naming it builds agentglass)
# plan <path>…: the jobs the planner selects for these changed paths, one per line; without this test, which names
# every path it plans for (paths no job may name are built at run time below, so this test does not name them either)
plan() {
  printf '%s\n' "$@" > "$t/changed"
  node scripts/check-plan.mjs --changed "$t/changed" $all | cut -f1 | grep -vx 'test:scripts/check-changed.test.sh' | sort > "$t/plan"
}
has() { grep -qxF "$1" "$t/plan" || bad "$2: $1 not selected"; }
hasnt() { ! grep -qxF "$1" "$t/plan" || bad "$2: $1 selected"; }
bin_tests=$(grep -l 'AGENTGLASS''_BIN' $tests) # (split: this test does not use the binary)

# a source file: every check that imports it (also transitively), every test that runs the binary, and the binary
plan src/util/gzip.ts
for j in check:src/util/gzip.check.ts check:src/util/inflate.check.ts test:scripts/gzip.test.sh bin release; do has $j gzip.ts; done
for f in $bin_tests; do has "test:$f" "gzip.ts (binary user)"; done
hasnt test:scripts/check-summary.test.sh gzip.ts; hasnt test:scripts/release-lib.test.sh gzip.ts; hasnt ALL gzip.ts
# transitive too: otlp.check.ts reaches otlp/state.ts only through the modules it imports
plan src/features/otlp/state.ts; has check:src/features/otlp/state.check.ts state.ts; has check:src/features/otlp/otlp.check.ts state.ts
# precise enough: a leaf module reaches its importers, not every check that names some "src/f" prefix
plan src/features/triage/score.ts; has check:src/features/triage/score.check.ts score.ts; hasnt check:src/features/repos/cli.check.ts score.ts
[ "$(grep -c '^check:' "$t/plan")" -le 15 ] || bad "score.ts: $(grep -c '^check:' "$t/plan") checks"

# a sibling script: its test (named by basename), and the test that scans scripts/*.sh; no binary
plan scripts/release-lib.sh
has test:scripts/release-lib.test.sh release-lib.sh; has test:scripts/sh-portability.test.sh release-lib.sh
hasnt bin release-lib.sh; hasnt ALL release-lib.sh; [ "$(wc -l < "$t/plan")" -le 4 ] || bad "release-lib.sh: $(wc -l < "$t/plan") jobs"

# fixtures: named by path prefix ("testdata/otlp/golden-" + h) or by name
plan testdata/otlp/golden-claude.json
has check:src/features/otlp/otlp.check.ts golden; has test:scripts/otlp-export.test.sh golden; has bin golden
plan testdata/hub/pb/logs.bin; has test:scripts/receive.test.sh logs.bin
plan specs/pi-opencode-harnesses/fixtures/opencode.sql; has check:src/harness/opencode.check.ts opencode.sql
plan docs/cli-contract.md; has test:scripts/contract.test.sh cli-contract.md

# the whole suite: what shapes every job, CI, non-TS sources, and anything no job names
n=nobody; for c in scripts/check.sh scripts/check-plan.mjs scripts/check-lock.sh scripts/toolchain.sh "build"".sh" .github/workflows/ci.yml \
  src/platform/darwin/ffi.json src/platform/darwin/libproc.c "$n-names-this.toml" "testdata/$n/$n-names-this.json"; do
  plan "$c"; [ "$(cat "$t/plan")" = ALL ] || bad "$c: want the full suite, got $(tr '\n' ' ' < "$t/plan")"
done
# documentation alone: nothing
plan README.md CHANGELOG.md specs/fleet/plan.md; [ ! -s "$t/plan" ] || bad "docs: selected $(tr '\n' ' ' < "$t/plan")"

# invariants: every job selects itself; every source file is reached by at least one job or is imported by none
plan $checks $tests
for f in $checks; do has "check:$f" "all changed"; done
for f in $tests; do [ "$f" = scripts/check-changed.test.sh ] || has "test:$f" "all changed"; done
plan $(find src -name '*.ts' ! -name '*.check.ts' ! -name build-info.ts | sort)
[ "$(grep -c '^check:' "$t/plan")" = "$(echo "$checks" | wc -l | tr -d ' ')" ] || bad "every source changed: not every check selected"
for f in $bin_tests; do has "test:$f" "every source changed"; done

# end to end: check.sh --changed --dry-run in a throwaway git copy of this tree (none of the outer check.sh's settings:
# its prebuilt binary would drop the bin job)
unset AGENTGLASS''_BIN AGENTGLASS_OUT CHECK_SHARD CHECK_RELEASE_OUT CHECK_FFI # (split: a test naming it runs the binary)
r="$t/repo"; mkdir -p "$r/docs"
cp -R scripts src testdata "build"".sh" .gitignore "$r/"; cp docs/cli-contract.md "$r/docs/"; rm -f "$r/src/build-info.ts"
echo "# r" > "$r/README.md"
cd "$r"
g() { git -c user.name=t -c user.email=t@t -c commit.gpgsign=false "$@"; }
g init -q; g add -A; g commit -qm base
run() { sh scripts/check.sh --changed "$@" --dry-run > "$t/out" 2>&1; }
want() { grep -qxF "$1" "$t/out" || { bad "$2: $1 not in the queue"; sed 's/^/  | /' "$t/out" | head -20; }; }
wantnt() { ! grep -qxF "$1" "$t/out" || bad "$2: $1 in the queue"; }

run HEAD || bad "clean tree: exit $?"; grep -q 'nothing changed' "$t/out" || bad "clean tree: $(cat "$t/out")"
echo '// changed' >> src/util/gzip.ts # uncommitted
run HEAD; want check:src/util/gzip.check.ts uncommitted; want test:scripts/gzip.test.sh uncommitted; want bin uncommitted
wantnt test:scripts/release-lib.test.sh uncommitted
grep -q '^  check src/util/gzip.check.ts: imports src/util/gzip.ts$' "$t/out" || grep -q 'checks: imports src/util/gzip.ts' "$t/out" || bad "uncommitted: no reason printed: $(head -5 "$t/out")"
g commit -qam gzip # committed: base...HEAD
run HEAD~1; want check:src/util/gzip.check.ts committed; want test:scripts/gzip.test.sh committed
printf '#!/bin/sh\necho ok\n' > scripts/zz-new.test.sh # untracked
run HEAD; want test:scripts/zz-new.test.sh untracked; wantnt check:src/util/gzip.check.ts untracked
rm scripts/zz-new.test.sh; echo more >> README.md # docs only
run HEAD; grep -q 'nothing to run' "$t/out" || bad "docs only: $(cat "$t/out")"; wantnt bin "docs only"
g checkout -q README.md; echo '// x' >> scripts/check-plan.mjs # the planner itself: everything
run HEAD; grep -q 'full suite' "$t/out" || bad "planner changed: $(head -3 "$t/out")"; want check:src/util/text.check.ts "planner changed"
g checkout -q scripts/check-plan.mjs
sh scripts/check.sh --changed no-such-ref --dry-run > "$t/out" 2>&1; rc=$?
[ $rc = 2 ] && grep -q "no-such-ref" "$t/out" || bad "bad base: exit $rc: $(cat "$t/out")"
sh scripts/check.sh --bogus > "$t/out" 2>&1; rc=$?; [ $rc = 2 ] && grep -q 'usage' "$t/out" || bad "unknown argument: exit $rc"

[ $fail = 0 ] && echo "check --changed: all tests passed"
exit $fail
