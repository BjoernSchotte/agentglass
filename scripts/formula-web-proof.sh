#!/bin/sh
# prove the rendered agentglass-web formula (release.yml's tap job, after formula-proof.sh proved agentglass): in a
# local clone of the tap, brew audit --strict, install (with the tap's agentglass), test. Leaves nothing installed.
#   sh scripts/formula-web-proof.sh <agentglass-web.rb> [<assets dir>] [<agentglass.rb>]
# <agentglass.rb>: the agentglass formula to depend on (a release not yet in the tap); <assets dir>: local archives.
set -e
rb="$1"; assets="$2"; dep="$3"; [ -f "$rb" ] || { echo "usage: sh scripts/formula-web-proof.sh <agentglass-web.rb> [<assets dir>] [<agentglass.rb>]" >&2; exit 2; }
rb=$(cd "$(dirname "$rb")" && pwd)/$(basename "$rb")
[ -z "$assets" ] || assets=$(cd "$assets" && pwd)
[ -z "$dep" ] || dep=$(cd "$(dirname "$dep")" && pwd)/$(basename "$dep")
brew=$(command -v brew || echo /home/linuxbrew/.linuxbrew/bin/brew)
[ -x "$brew" ] || { echo "formula-web-proof.sh: no brew" >&2; exit 1; }
eval "$("$brew" shellenv)"
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ENV_HINTS=1
tap=bjoernschotte/tap
brew tap "$tap"
if brew commands | grep -qx trust; then brew trust --tap "$tap"; fi
d="$(brew --repository "$tap")/Formula"; f="$d/agentglass-web.rb"
cleanup() { [ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; brew uninstall --force agentglass-web agentglass > /dev/null 2>&1 || true; rm -f "$f"; git -C "$d" checkout -q -- . 2> /dev/null || true; }
trap cleanup EXIT
cp "$rb" "$f"; [ -z "$dep" ] || cp "$dep" "$d/agentglass.rb"
brew audit --strict --except=version --formula "$tap/agentglass-web"
if [ -n "$assets" ]; then
  sed -i.bak "s|url \"https://github.com/[^\"]*/\(agentglass[a-z0-9-]*\.tar\.gz\)\"|url \"file://$assets/\1\"|" "$f" && rm -f "$f.bak"
  [ -z "$dep" ] || { sed -i.bak "s|url \"https://github.com/[^\"]*/\(agentglass-[a-z0-9-]*\.tar\.gz\)\"|url \"file://$assets/\1\"|" "$d/agentglass.rb" && rm -f "$d/agentglass.rb.bak"; }
fi
brew install --formula "$tap/agentglass-web"
brew test "$tap/agentglass-web"
"$(brew --prefix)/bin/agentglass-web" --version
