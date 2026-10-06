#!/bin/sh
# cut a stable release: sh scripts/release.sh [--dry-run] [--yes]
# checks main is clean, in sync and green, writes the CHANGELOG section, commits, tags v<version>, pushes (the tag starts release.yml)
set -e
cd "$(dirname "$0")/.."; . scripts/release-lib.sh
dry=0; yes=0
for a in "$@"; do case "$a" in --dry-run) dry=1;; --yes) yes=1;; *) echo "usage: release.sh [--dry-run] [--yes]" >&2; exit 2;; esac; done
[ "$(git branch --show-current)" = main ] || { echo "release.sh: not on main" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "release.sh: working tree not clean" >&2; exit 1; }
git fetch -q origin main --tags
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "release.sh: main is not in sync with origin/main" >&2; exit 1; }
ci=$(ci_gate HEAD) # HEAD's run, or the last run before docs-only commits (ci.yml skips those)
[ "$ci" = success ] || { echo "release.sh: CI for HEAD is '$ci', need success" >&2; exit 1; }
v=$(next_version); prev=$(last_stable_tag HEAD)
body=$(changelog "$prev" HEAD)
printf '## %s\n\n%s\n' "$v" "$body"
[ $dry = 1 ] && { echo "(dry run — nothing written)"; exit 0; }
prepend_changelog "$v" "$body"
if [ $yes = 0 ]; then
  ${EDITOR:-vi} CHANGELOG.md
  printf 'release %s? [y/N] ' "$v"; read -r ok
  [ "$ok" = y ] || { git checkout CHANGELOG.md; echo "aborted"; exit 1; }
fi
git add CHANGELOG.md && git commit -qm "chore(release): $v"
git tag -a "v$v" -m "agentglass $v"
git push --atomic origin main "v$v"
echo "released v$v — https://github.com/BjoernSchotte/agentglass/actions/workflows/release.yml"
