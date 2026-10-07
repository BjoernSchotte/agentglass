#!/bin/sh
# tests for publish-release.sh with a fake gh: sh scripts/publish-release.test.sh
set -e
here=$(cd "$(dirname "$0")" && pwd); t=$(mktemp -d); trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; rm -rf "$t"' EXIT
fail=0
mkdir -p "$t/bin" "$t/out"
cat > "$t/bin/gh" <<'EOG'
#!/bin/sh
# fake gh: state in $STATE (none|draft|published), every call logged
echo "$*" >> "$LOG"
case "$1 $2" in
  "release view")
    case "$(cat "$STATE")" in none) exit 1;; draft) echo true;; published) echo false;; esac ;;
  "release create") echo draft > "$STATE" ;;
  "release upload") ;;
  "release download") d=""; while [ $# -gt 0 ]; do [ "$1" = -D ] && d="$2"; shift; done; mkdir -p "$d"; cp "$SRC"/* "$d/" ;;
  "release edit") echo published > "$STATE" ;;
esac
EOG
chmod +x "$t/bin/gh"
for p in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do echo "b $p" > "$t/out/agentglass-$p.tar.gz"; done
sh "$here/release-assets.sh" "$t/out" stable v2026.9.1 2026.9.1 0123456789abcdef0123456789abcdef01234567 >/dev/null
echo notes > "$t/notes.md"
run() { echo "$1" > "$t/state"; : > "$t/log"; shift
  PATH="$t/bin:$PATH" LOG="$t/log" STATE="$t/state" SRC="$t/out" sh "$here/publish-release.sh" "$@" > "$t/o" 2>&1; }
has() { grep -q -- "$1" "$t/log" || { echo "FAIL $2: no '$1' in $(tr '\n' '|' < "$t/log")"; fail=1; }; }
hasnt() { if grep -q -- "$1" "$t/log"; then echo "FAIL $2: unexpected '$1'"; fail=1; fi; }
run none v2026.9.1 "$t/out" "$t/notes.md" stable || { echo "FAIL new stable: $(cat "$t/o")"; fail=1; }
has "release create v2026.9.1 --draft" "new: draft first"; has "release upload v2026.9.1" "new: upload"; has "--draft=false --latest" "new: publish latest"
run draft v2026.9.1 "$t/out" "$t/notes.md" stable || { echo "FAIL rerun on draft: $(cat "$t/o")"; fail=1; }
hasnt "release create" "draft rerun: no second create"; has "upload v2026.9.1 .* --clobber" "draft rerun: clobber into the draft"
if run published v2026.9.1 "$t/out" "$t/notes.md" stable; then echo "FAIL published release accepted a rebuild"; fail=1; fi
hasnt "release upload" "published: never uploads"; hasnt "release edit" "published: never edits"
grep -qi "already published" "$t/o" || { echo "FAIL published message: $(cat "$t/o")"; fail=1; }
run none dev-20261005.1.1-a1b2c3d4 "$t/out" "$t/notes.md" dev || { echo "FAIL dev: $(cat "$t/o")"; fail=1; }
has "--prerelease" "dev: prerelease"; has "--latest=false" "dev: never latest"
[ $fail = 0 ] && echo "publish-release: all tests passed"; exit $fail
