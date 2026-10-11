#!/bin/sh
# render the Homebrew formula agentglass-web (BjoernSchotte/homebrew-tap Formula/agentglass-web.rb) from a release's
# assets: sh scripts/formula-web.sh <dir> <version>   (dir: the agentglass-web-<target>.tar.gz archives + SHA256SUMS)
# It depends on the tap's agentglass; its test starts agentglass-web on loopback with that agentglass and fetches the page.
set -e
dir="$1"; version="$2"
[ -n "$dir" ] && [ -n "$version" ] || { echo "usage: sh scripts/formula-web.sh <dir> <version>" >&2; exit 2; }
echo "$version" | grep -Eq '^[0-9]{4}\.[1-9][0-9]?\.[1-9][0-9]*$' || { echo "formula-web.sh: bad version $version" >&2; exit 2; }
repo=BjoernSchotte/agentglass
sha() { awk -v n="agentglass-web-$1.tar.gz" '$2 == n || $2 == "*" n { print $1 }' "$dir/SHA256SUMS"; }
for p in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  sha "$p" | grep -Eq '^[0-9a-f]{64}$' || { echo "formula-web.sh: no checksum for agentglass-web-$p.tar.gz in $dir/SHA256SUMS" >&2; exit 1; }
  tar -tzf "$dir/agentglass-web-$p.tar.gz" | grep -qx 'agentglass-web' || { echo "formula-web.sh: agentglass-web-$p.tar.gz has no agentglass-web" >&2; exit 1; }
done
url() { echo "https://github.com/$repo/releases/download/v#{version}/agentglass-web-$1.tar.gz"; }
cat << RUBY
class AgentglassWeb < Formula
  desc "Web UI for agentglass: your coding agents' sessions live in the browser"
  homepage "https://github.com/$repo"
  version "$version"
  license "Apache-2.0"

  depends_on "bjoernschotte/tap/agentglass"

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

  def install
    bin.install "agentglass-web"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/agentglass-web --version")
    # a real start on loopback with the agentglass it depends on (an empty HOME: no sessions), then the page
    port = free_port
    ag = formula_opt_bin("bjoernschotte/tap/agentglass")/"agentglass"
    pid = spawn "#{bin}/agentglass-web", "--agentglass", ag.to_s,
                "--port", port.to_s, out: (testpath/"out").to_s, err: (testpath/"err").to_s
    begin
      20.times do
        break if (testpath/"out").exist? && (testpath/"out").read.include?("url")

        sleep 0.5
      end
      assert_match "\"port\":#{port}", (testpath/"out").read
      assert_match "agentglass", shell_output("curl -fsS http://127.0.0.1:#{port}/")
    ensure
      Process.kill("TERM", pid)
      Process.wait(pid)
    end
  end
end
RUBY
