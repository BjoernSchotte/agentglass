#!/bin/sh
# upload verified assets to a GitHub release and publish it: publish-release.sh <tag> <dir> <notes-file> <stable|dev> [title] [target-sha]
# Only ever writes to drafts: a published release is never touched again (its assets are what Homebrew and SHA256SUMS users pinned).
set -e
here=$(cd "$(dirname "$0")" && pwd)
tag="$1"; dir="$2"; notes="$3"; channel="$4"; title="${5:-agentglass $1}"; target="${6:-}"
draft=$(gh release view "$tag" --json isDraft -q .isDraft 2>/dev/null || echo none)
case "$draft" in
  false) echo "publish-release: $tag is already published — its assets are never replaced; cut a new release instead" >&2; exit 1 ;;
  true) echo "publish-release: resuming draft $tag" ;;
  *)
    if [ "$channel" = dev ]; then gh release create "$tag" --draft --prerelease ${target:+--target "$target"} --title "$title" --notes-file "$notes"
    else gh release create "$tag" --draft --verify-tag --title "$title" --notes-file "$notes"; fi ;;
esac
gh release upload "$tag" "$dir"/* --clobber
check=$(mktemp -d); trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; rm -rf "$check"' EXIT
gh release download "$tag" -D "$check" && sh "$here/verify-release-assets.sh" "$check"
if [ "$channel" = dev ]; then gh release edit "$tag" --draft=false --prerelease --latest=false
else gh release edit "$tag" --draft=false --latest; fi
