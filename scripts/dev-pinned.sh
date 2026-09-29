#!/bin/sh
# prints the dev tag Homebrew's agentglass-dev points to ("" when the tap has no pointer yet); exit 1 when that cannot be known
err=$(mktemp); trap 'rm -f "$err"' EXIT
if ! out=$(gh api repos/BjoernSchotte/homebrew-tap/contents/metadata/agentglass-dev.json -H "Accept: application/vnd.github.raw" 2>"$err"); then
  if grep -q "404" "$err" || printf %s "$out" | grep -q '"status":"404"'; then exit 0; fi
  echo "dev-pinned: cannot read the Homebrew pointer: $(cat "$err")" >&2; exit 1
fi
tag=$(printf %s "$out" | sed -n 's/.*"tag": *"\([^"]*\)".*/\1/p')
[ -n "$tag" ] || { echo "dev-pinned: pointer has no tag" >&2; exit 1; }
echo "$tag"
