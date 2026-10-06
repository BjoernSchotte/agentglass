#!/bin/sh
# tests for release-lib.sh in a throwaway git repo: sh scripts/release-lib.test.sh
set -e
here=$(cd "$(dirname "$0")" && pwd); t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
cd "$t" && git init -q && git config user.email t@t && git config user.name t && git config commit.gpgsign false && git config tag.gpgsign false
. "$here/release-lib.sh"
# never reach GitHub from tests: a fake gh answers from $t/ghdata ("<sha>\t<merged PR> <PR author>\t<commit author login>")
mkdir bin; cat > bin/gh <<'GH'
#!/bin/sh
[ -f "$GHFAIL" ] && exit 1
p="$2"; sha=${p##*/commits/}; k=author; case "$sha" in */pulls) k=pulls; sha=${sha%/pulls};; esac
[ -f "$GHDATA" ] || exit 0
awk -F'\t' -v s="$sha" -v k="$k" '$1 == s { print (k == "pulls" ? $2 : $3) }' "$GHDATA"
GH
chmod +x bin/gh; export RELEASE_GH="$t/bin/gh" GHDATA="$t/ghdata" GHFAIL="$t/ghfail" RELEASE_REPO=o/r RELEASE_MAINTAINERS=maint RELEASE_MAINTAINER_NAMES=t
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
# contributors + PR links (GitHub metadata via gh), Build & CI section
git tag -a v2026.9.20 -m x
ca() { n="$1"; shift; echo "$1" >> f; git add f; git -c user.name="$n" -c user.email="$n@x" commit -qm "$1"; git rev-parse HEAD; }
s1=$(ca "Alice A" "fix(kiro): iso dates"); s2=$(ca t "fix(usage): cache bump"); s3=$(ca "dependabot[bot]" "build(deps): bump x")
s4=$(ca "Bob B" "ci: faster matrix"); s5=$(ca "Carol C" "feat: reverted later"); git revert --no-edit HEAD >/dev/null
printf '%s\t5 alice\talice\n%s\t5 alice\tmaint\n%s\t6 dependabot[bot]\tdependabot[bot]\n%s\t\tbob\n%s\t\tcarol\n' "$s1" "$s2" "$s3" "$s4" "$s5" > ghdata
log=$(changelog v2026.9.20 HEAD)
echo "$log" | grep -qF -- "- **kiro:** iso dates ($(echo "$s1" | cut -c1-7), [#5](https://github.com/o/r/pull/5))" || { echo "FAIL PR link"; echo "$log"; fail=1; }
echo "$log" | grep -q '^### Build & CI' && echo "$log" | grep -q 'faster matrix' || { echo "FAIL build & ci section"; echo "$log"; fail=1; }
eq "contributors" "$(echo "$log" | sed -n '/^### Contributors/,$p' | tr '\n' '|')" "### Contributors||- @alice ([#5](https://github.com/o/r/pull/5))|- @bob|"
eq "contributors last" "$(echo "$log" | grep '^### ' | tail -1)" "### Contributors"
touch ghfail; log=$(changelog v2026.9.20 HEAD); rm ghfail
eq "gh failing: git author names" "$(echo "$log" | sed -n '/^### Contributors/,$p' | tr '\n' '|')" "### Contributors||- Alice A|- Bob B|"
echo "$log" | grep -q 'pull/5' && { echo "FAIL no PR links without gh"; fail=1; }
log=$(RELEASE_OFFLINE=1 changelog v2026.9.20 HEAD)
eq "offline: git author names" "$(echo "$log" | sed -n '/^### Contributors/,$p' | tr '\n' '|')" "### Contributors||- Alice A|- Bob B|"
eq "only maintainer: no section" "$(RELEASE_OFFLINE=1 changelog "$s1" "$s2" | grep -c '^### Contributors')" "0"
printf '# Changelog\n\nAll notable changes.\n' > CHANGELOG.md
prepend_changelog 2026.9.2 "- x"; prepend_changelog 2026.9.3 "- y"
eq "intro kept" "$(head -3 CHANGELOG.md | tr '\n' '|')" "# Changelog||All notable changes.|"
eq "notes_for newest" "$(notes_for 2026.9.3)" "- y"
eq "notes_for older" "$(notes_for 2026.9.2)" "- x"
eq "order" "$(grep -n '^## ' CHANGELOG.md | cut -d: -f2- | tr '\n' ' ')" "## 2026.9.3 ## 2026.9.2 "
eq "notes_for missing" "$(notes_for 2026.1.1)" ""

# ci_gate: HEAD's CI, or — when HEAD and the commits after the last CI run only touch files ci.yml ignores — that run's
_ci_lookup() { awk -v s="$1" '$1 == s { print $2 }' "$t/cidata"; }
: > "$t/cidata"
c "code: x"; green=$(git rev-parse HEAD); printf '%s success\n' "$green" >> "$t/cidata"
eq "ci head green" "$(ci_gate HEAD)" "success"
mkdir -p docs; echo d > README.md; echo d > docs/a.txt; git add README.md docs/a.txt; git commit -qm "docs: only"
eq "ci docs-only head uses last run" "$(ci_gate HEAD)" "success"
echo x > LICENSE; git add LICENSE; git commit -qm "license"
eq "ci docs chain" "$(ci_gate HEAD)" "success"
echo s > script.sh; git add script.sh; git commit -qm "code without ci"
eq "ci code head without run" "$(ci_gate HEAD)" "missing"
git reset -q --hard HEAD~1
printf '%s failure\n' "$green" > "$t/cidata"
eq "ci last run failed" "$(ci_gate HEAD)" "failure"
: > "$t/cidata"
eq "ci no run anywhere" "$(ci_gate HEAD)" "missing"
[ $fail = 0 ] && echo "release-lib: all tests passed"; exit $fail
