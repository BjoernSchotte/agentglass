#!/bin/sh
# tests for install.sh against file:// fixture releases: sh scripts/install.test.sh
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR # hermetic: the fake HOME decides, not the caller's overrides
export AGENTGLASS_AGENT=0 # human-mode behavior, also when the suite runs inside a coding agent
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; chmod -R u+w "$t"; rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
os=$(uname -s | tr 'A-Z' 'a-z'); case "$(uname -m)" in x86_64|amd64) arch=x64;; aarch64|arm64) arch=arm64;; esac
asset="agentglass-$os-$arch.tar.gz"
if command -v sha256sum >/dev/null 2>&1; then H="sha256sum"; else H="shasum -a 256"; fi
rel() { # rel <tag> <version>: fake release dir with a binary printing <version>
  d="$t/dl/$1"; mkdir -p "$d/x"; printf '#!/bin/sh\necho %s\n' "$2" > "$d/x/agentglass"; chmod 755 "$d/x/agentglass"
  tar -czf "$d/$asset" -C "$d/x" agentglass; rm -rf "$d/x"; (cd "$d" && $H "$asset" > SHA256SUMS)
}
rel v2026.9.2 2026.9.2; rel v2026.9.1 2026.9.1; rel dev-20260930.3.1-a1b2c3d4 2026.9.2-dev.20260930.3+a1b2c3d4; rel dev-20260929.9.1-b1b2c3d4 2026.9.2-dev.20260929.9+b1b2c3d4
cat > "$t/api.json" <<EOJ
[
  {"tag_name": "dev-20260929.9.1-b1b2c3d4", "draft": false, "prerelease": true},
  {"tag_name": "v2026.10.1", "draft": true, "prerelease": false},
  {"tag_name": "v2026.9.2", "draft": false, "prerelease": false},
  {"tag_name": "dev-20260930.3.1-a1b2c3d4", "draft": false, "prerelease": true},
  {"tag_name": "v2026.9.1", "draft": false, "prerelease": false}
]
EOJ
export AGENTGLASS_RELEASES_API="file://$t/api.json" AGENTGLASS_DOWNLOAD_BASE="file://$t/dl"
run() { HOME="$t/home" PATH="/usr/bin:/bin" sh "$here/install.sh" "$@" > "$t/out" 2>&1; }
must() { run "$@" || { echo "FAIL install.sh $*: $(cat "$t/out")"; fail=1; }; }
mkdir -p "$t/home"
run && eq "stable exit" 0 0 || eq "stable exit" 1 0
eq "stable version" "$("$t/home/.local/bin/agentglass")" "2026.9.2"
grep -q '"method":"script"' "$t/home/.agentglass/install.json" && grep -q '"channel":"stable"' "$t/home/.agentglass/install.json" && grep -q "\"path\":\"$(cd "$t" && pwd -P)/home/.local/bin/agentglass\"" "$t/home/.agentglass/install.json" && grep -q '"version":"2026.9.2"' "$t/home/.agentglass/install.json" || { echo "FAIL install.json: $(cat "$t/home/.agentglass/install.json")"; fail=1; }
grep -q "not on your PATH" "$t/out" || { echo "FAIL PATH warning"; fail=1; }
must --channel dev; eq "dev version" "$("$t/home/.local/bin/agentglass")" "2026.9.2-dev.20260930.3+a1b2c3d4"
grep -q '"channel":"dev"' "$t/home/.agentglass/install.json" || { echo "FAIL dev channel in install.json"; fail=1; }
must --version 2026.9.1; eq "pinned version" "$("$t/home/.local/bin/agentglass")" "2026.9.1"
must --prefix "$t/p2"; eq "prefix" "$("$t/p2/agentglass")" "2026.9.2"
echo x >> "$t/dl/v2026.9.2/$asset"; rm -f "$t/p3/agentglass"
if run --prefix "$t/p3"; then echo "FAIL checksum mismatch accepted"; fail=1; fi
grep -qi "checksum" "$t/out" || { echo "FAIL checksum message: $(cat "$t/out")"; fail=1; }
[ ! -e "$t/p3/agentglass" ] || { echo "FAIL binary written despite mismatch"; fail=1; }
mkdir -p "$t/ro" && chmod 555 "$t/ro"
if run --version 2026.9.1 --prefix "$t/ro"; then echo "FAIL read-only prefix accepted"; fail=1; fi
grep -qi "cannot write" "$t/out" || { echo "FAIL read-only message: $(cat "$t/out")"; fail=1; }
# subshell: bash in POSIX mode (macOS /bin/sh) keeps assignments made in front of a function call
if (AGENTGLASS_TEST_UNAME_M=riscv64; export AGENTGLASS_TEST_UNAME_M; run --prefix "$t/p4"); then echo "FAIL riscv accepted"; fail=1; fi
grep -qi "unsupported" "$t/out" || { echo "FAIL unsupported message"; fail=1; }
if run --channel nightly; then echo "FAIL bad channel accepted"; fail=1; fi
[ -z "$(ls -A "$t/home/.local/bin" | grep -v '^agentglass$' || true)" ] || { echo "FAIL leftovers in prefix: $(ls -A "$t/home/.local/bin")"; fail=1; }
# a binary that cannot run here (e.g. needs a newer glibc) is never installed over a working one
rel v2026.9.5 broken; printf '#!/bin/sh\nexit 127\n' > "$t/brk"; chmod 755 "$t/brk"; tar -czf "$t/dl/v2026.9.5/$asset" -C "$t" brk --transform 's/brk/agentglass/' 2>/dev/null || { mkdir -p "$t/b2"; cp "$t/brk" "$t/b2/agentglass"; tar -czf "$t/dl/v2026.9.5/$asset" -C "$t/b2" agentglass; }
(cd "$t/dl/v2026.9.5" && $H "$asset" > SHA256SUMS)
must --prefix "$t/p2" --version 2026.9.1
if run --prefix "$t/p2" --version 2026.9.5; then echo "FAIL broken binary installed"; fail=1; fi
grep -qi "does not run" "$t/out" || { echo "FAIL broken message: $(cat "$t/out")"; fail=1; }
eq "working binary kept" "$("$t/p2/agentglass")" "2026.9.1"
# an archive with the optional HTTPS receiver installs it next to agentglass; one without leaves an older one alone
d="$t/dl/v2026.9.6"; mkdir -p "$d/x"; printf '#!/bin/sh\necho 2026.9.6\n' > "$d/x/agentglass"; printf '#!/bin/sh\necho tls\n' > "$d/x/agentglass-receive-tls"; chmod 755 "$d/x/"*
tar -czf "$d/$asset" -C "$d/x" agentglass agentglass-receive-tls; rm -rf "$d/x"; (cd "$d" && $H "$asset" > SHA256SUMS)
must --prefix "$t/p6" --version 2026.9.6
eq "tls binary installed" "$("$t/p6/agentglass-receive-tls" 2>/dev/null)" tls
must --prefix "$t/p6" --version 2026.9.1
eq "tls binary kept by an archive without it" "$("$t/p6/agentglass-receive-tls" 2>/dev/null)" tls
# a download cut off mid-script runs nothing
lines=$(wc -l < "$here/install.sh")
for pct in 25 50 75 90 95; do
  head -n $((lines * pct / 100)) "$here/install.sh" > "$t/cut.sh"
  HOME="$t/home2" sh "$t/cut.sh" --prefix "$t/p5" > "$t/cut.out" 2>&1 || true
  if grep -q "agentglass:" "$t/cut.out" || [ -e "$t/p5" ] || [ -e "$t/home2" ]; then echo "FAIL installer cut at $pct% still ran: $(head -2 "$t/cut.out" | tr '\n' ' ')"; fail=1; fi
done
[ $fail = 0 ] && echo "install.sh: all tests passed"; exit $fail
