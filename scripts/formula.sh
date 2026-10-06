#!/bin/sh
# render the stable Homebrew formula (BjoernSchotte/homebrew-tap Formula/agentglass.rb) from a release's assets:
#   sh scripts/formula.sh <dir> <version>   (dir: the 4 archives + SHA256SUMS, as verify-release-assets.sh checks them)
# Installs agentglass and, from each archive that ships it, agentglass-receive-tls (otlp-hub 11.4: a target whose C-backend
# build failed ships without it, so the install line is guarded per archive). Lists on stderr which archives carry it.
set -e
dir="$1"; version="$2"
[ -n "$dir" ] && [ -n "$version" ] || { echo "usage: sh scripts/formula.sh <dir> <version>" >&2; exit 2; }
echo "$version" | grep -Eq '^[0-9]{4}\.[1-9][0-9]?\.[1-9][0-9]*$' || { echo "formula.sh: bad version $version" >&2; exit 2; }
repo=BjoernSchotte/agentglass
sha() { awk -v n="agentglass-$1.tar.gz" '$2 == n || $2 == "*" n { print $1 }' "$dir/SHA256SUMS"; }
tls=""
for p in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  s=$(sha "$p"); echo "$s" | grep -Eq '^[0-9a-f]{64}$' || { echo "formula.sh: no checksum for agentglass-$p.tar.gz in $dir/SHA256SUMS" >&2; exit 1; }
  # the archive holds agentglass and maybe agentglass-receive-tls, at its top level (scripts/package.sh)
  list=$(tar -tzf "$dir/agentglass-$p.tar.gz") || { echo "formula.sh: cannot read agentglass-$p.tar.gz" >&2; exit 1; }
  echo "$list" | grep -qx 'agentglass' || { echo "formula.sh: agentglass-$p.tar.gz has no agentglass" >&2; exit 1; }
  if echo "$list" | grep -qx 'agentglass-receive-tls'; then tls="$tls $p"; fi
done
echo "formula.sh: agentglass-receive-tls in:${tls:- none}" >&2
url() { echo "https://github.com/$repo/releases/download/v#{version}/agentglass-$1.tar.gz"; }
cat << RUBY
class Agentglass < Formula
  desc "See every coding agent on your machine — live, down to every tool call"
  homepage "https://github.com/$repo"
  version "$version"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "$(url darwin-arm64)"
      sha256 "$(sha darwin-arm64)"
    end
    on_intel do
      url "$(url darwin-x64)"
      sha256 "$(sha darwin-x64)"
    end
  end

  on_linux do
    on_arm do
      url "$(url linux-arm64)"
      sha256 "$(sha linux-arm64)"
    end
    on_intel do
      url "$(url linux-x64)"
      sha256 "$(sha linux-x64)"
    end
  end

  conflicts_with "agentglass-dev", because: "both formulae install the agentglass executable"

  def install
    bin.install "agentglass"
    # agentglass receive with built-in HTTPS; a target whose TLS build failed ships without it
    bin.install "agentglass-receive-tls" if File.exist?("agentglass-receive-tls")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/agentglass --version")
    if (bin/"agentglass-receive-tls").exist?
      assert_match version.to_s, shell_output("#{bin}/agentglass-receive-tls --version")
    end
  end
end
RUBY
