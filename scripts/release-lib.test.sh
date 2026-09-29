#!/bin/sh
# tests for release-lib.sh in a throwaway git repo: sh scripts/release-lib.test.sh
set -e
here=$(cd "$(dirname "$0")" && pwd); t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
cd "$t" && git init -q && git config user.email t@t && git config user.name t && git config commit.gpgsign false && git config tag.gpgsign false
. "$here/release-lib.sh"
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
c() { echo "$1" >> f; git add f; git commit -qm "$1"; }
c "feat: first"
eq "no tags at all" "$(next_version 2026.9)" "2026.9.1"
eq "no stable yet" "$(last_stable_tag HEAD)" ""
git tag -a v2026.8.3 -m x
eq "only last month" "$(next_version 2026.9)" "2026.9.1"
c "fix: a"; git tag -a v2026.9.1 -m x; c "fix: b"; git tag -a v2026.9.3 -m x
eq "gap" "$(next_version 2026.9)" "2026.9.4"
git tag -a v2026.9.10 -m x
git tag -a v2026.09.99 -m x; git tag -a dev-20260930.1.1-a1b2c3d4 -m x
eq "numeric not lexical, malformed ignored" "$(next_version 2026.9)" "2026.9.11"
eq "last stable" "$(last_stable_tag HEAD)" "v2026.9.10"
eq "sort" "$(printf '2026.9.10\n2026.10.1\n2026.9.2\n' | sort_versions | tr '\n' ' ')" "2026.9.2 2026.9.10 2026.10.1 "
c "feat(update)!: self update"; c "fix: crash on empty list"; c "perf: faster scan"; c "docs: readme"
c "refactor: split module"; c "chore(release): 2026.9.11"; c "feat: to be reverted"
git revert --no-edit HEAD >/dev/null
c "just a subject without type"
log=$(changelog v2026.9.10 HEAD)
echo "$log" | grep -q '^### Breaking changes' || { echo "FAIL breaking section"; fail=1; }
echo "$log" | grep -q '^- \*\*update:\*\* self update (' || { echo "FAIL scope rendering"; echo "$log"; fail=1; }
echo "$log" | grep -q '^### Fixes' && echo "$log" | grep -q 'crash on empty list' || { echo "FAIL fixes"; fail=1; }
echo "$log" | grep -q '^### Performance' || { echo "FAIL perf"; fail=1; }
echo "$log" | grep -q '^### Docs' || { echo "FAIL docs"; fail=1; }
echo "$log" | grep -q 'just a subject without type' || { echo "FAIL untyped goes to other"; fail=1; }
if echo "$log" | grep -q 'chore(release)\|2026.9.11'; then echo "FAIL release commit leaked"; fail=1; fi
if echo "$log" | grep -q 'to be reverted'; then echo "FAIL revert pair leaked"; echo "$log"; fail=1; fi
eq "empty range" "$(changelog HEAD HEAD)" "- No changes."
b=$(echo "$log" | grep -n '^### Breaking' | cut -d: -f1); fe=$(echo "$log" | grep -n '^### Features' | cut -d: -f1 || true)
[ -z "$fe" ] || [ "$b" -lt "$fe" ] || { echo "FAIL breaking first"; fail=1; }
printf '# Changelog\n\nAll notable changes.\n' > CHANGELOG.md
prepend_changelog 2026.9.2 "- x"; prepend_changelog 2026.9.3 "- y"
eq "intro kept" "$(head -3 CHANGELOG.md | tr '\n' '|')" "# Changelog||All notable changes.|"
eq "notes_for newest" "$(notes_for 2026.9.3)" "- y"
eq "notes_for older" "$(notes_for 2026.9.2)" "- x"
eq "order" "$(grep -n '^## ' CHANGELOG.md | cut -d: -f2- | tr '\n' ' ')" "## 2026.9.3 ## 2026.9.2 "
eq "notes_for missing" "$(notes_for 2026.1.1)" ""
[ $fail = 0 ] && echo "release-lib: all tests passed"; exit $fail
