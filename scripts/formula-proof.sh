#!/bin/sh
# prove a rendered stable formula before it ships (release.yml's tap job; formula.yml runs it on PRs against the last
# release): sh scripts/formula-proof.sh <agentglass.rb> [<assets dir>]
# <assets dir>: install from these local archives instead of the release (release-dry-run.yml: nothing is published yet);
# the audit still reads the formula as it would ship.
# It goes into a local clone of the real tap, so its conflict with agentglass-dev resolves, then: brew audit --strict,
# install, test, and agentglass-receive-tls --version when the formula installed it. Leaves nothing installed.
# `--except=version`: the url interpolates #{version} (the tap's update-formula.yml, the fallback, only swaps the version
# line and the checksums), which strict audit calls redundant; every other check stays on.
set -e
rb="$1"; assets="$2"; [ -f "$rb" ] || { echo "usage: sh scripts/formula-proof.sh <agentglass.rb> [<assets dir>]" >&2; exit 2; }
rb=$(cd "$(dirname "$rb")" && pwd)/$(basename "$rb")
if [ -n "$assets" ]; then
  [ -d "$assets" ] || { echo "formula-proof.sh: no assets dir $assets" >&2; exit 2; }
  assets=$(cd "$assets" && pwd)
fi
brew=$(command -v brew || echo /home/linuxbrew/.linuxbrew/bin/brew)
[ -x "$brew" ] || { echo "formula-proof.sh: no brew" >&2; exit 1; }
eval "$("$brew" shellenv)"
# runner images ship an older Homebrew (without `brew trust`, 2026-10); update once, then never in the middle
brew update --quiet
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ENV_HINTS=1
tap=bjoernschotte/tap
brew tap "$tap"
# current Homebrew loads formulae from third-party taps only once trusted
if brew commands | grep -qx trust; then brew trust --tap "$tap"; fi
f="$(brew --repository "$tap")/Formula/agentglass.rb"
cleanup() { [ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; brew uninstall --force agentglass > /dev/null 2>&1 || true; git -C "$(dirname "$f")" checkout -q -- agentglass.rb 2> /dev/null || true; }
trap cleanup EXIT
cp "$rb" "$f"
brew audit --strict --except=version --formula "$tap/agentglass"
# the release URL -> the local archive (the checksums stay: they are what the install checks)
if [ -n "$assets" ]; then
  sed -i.bak "s|url \"https://github.com/[^\"]*/\(agentglass-[a-z0-9-]*\.tar\.gz\)\"|url \"file://$assets/\1\"|" "$f" && rm -f "$f.bak"
  [ "$(grep -c 'url "file://' "$f")" = 4 ] || { echo "formula-proof.sh: could not point the formula at $assets" >&2; exit 1; }
fi
brew install --formula "$tap/agentglass"
brew test "$tap/agentglass"
"$(brew --prefix)/bin/agentglass" --version
if [ -x "$(brew --prefix)/bin/agentglass-receive-tls" ]; then "$(brew --prefix)/bin/agentglass-receive-tls" --version; fi
echo "formula-proof: audit, install and test passed"
