#!/bin/sh
# the stable Homebrew formula generator (release.yml's tap job): checksums per platform, agentglass-receive-tls installed
# from the archives that ship it, refusals: sh scripts/formula.test.sh
set -e
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
has() { case "$2" in *"$3"*) ;; *) echo "FAIL $1: '$3' not in output"; fail=1 ;; esac; }
if command -v sha256sum > /dev/null 2>&1; then H="sha256sum"; else H="shasum -a 256"; fi
# assets <dir> <platforms with the tls binary…>: four archives as package.sh packs them, plus SHA256SUMS
assets() {
  d=$1; shift; mkdir -p "$d/x"
  for p in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
    rm -f "$d/x/"*; printf '#!/bin/sh\necho 2026.10.8 %s\n' "$p" > "$d/x/agentglass"; f="agentglass"
    case " $* " in *" $p "*) printf '#!/bin/sh\necho 2026.10.8\n' > "$d/x/agentglass-receive-tls"; f="agentglass agentglass-receive-tls" ;; esac
    tar -czf "$d/agentglass-$p.tar.gz" -C "$d/x" $f
  done
  rm -rf "$d/x"; (cd "$d" && $H agentglass-*.tar.gz | sort -k2 > SHA256SUMS)
}
assets "$t/a" darwin-arm64 linux-x64 linux-arm64
f=$(sh "$here/scripts/formula.sh" "$t/a" 2026.10.8 2> "$t/err") && c=0 || c=$?
eq "render exit" "$c" 0
has "version" "$f" 'version "2026.10.8"'
for p in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  s=$(awk -v n="agentglass-$p.tar.gz" '$2 == n { print $1 }' "$t/a/SHA256SUMS")
  # each platform's url line is followed by its own checksum
  eq "checksum after the $p url" "$(echo "$f" | grep -A1 "agentglass-$p.tar.gz\"" | sed -n '2s/.*sha256 "\(.*\)"/\1/p')" "$s"
done
has "url uses the version" "$f" 'releases/download/v#{version}/agentglass-linux-x64.tar.gz'
has "installs agentglass" "$f" 'bin.install "agentglass"'
has "installs the tls binary where shipped" "$f" 'bin.install "agentglass-receive-tls" if File.exist?("agentglass-receive-tls")'
has "tests the tls binary when installed" "$f" '#{bin}/agentglass-receive-tls --version'
has "conflict with the dev channel" "$f" 'conflicts_with "agentglass-dev"'
eq "stderr lists the archives with tls" "$(cat "$t/err")" "formula.sh: agentglass-receive-tls in: darwin-arm64 linux-arm64 linux-x64"
if command -v ruby > /dev/null 2>&1; then echo "$f" > "$t/agentglass.rb"; ruby -c "$t/agentglass.rb" > /dev/null 2>&1 || { echo "FAIL ruby syntax: $(ruby -c "$t/agentglass.rb" 2>&1)"; fail=1; }; fi
# no archive with tls: the guarded line stays (the formula does not depend on which targets built it)
assets "$t/b"; sh "$here/scripts/formula.sh" "$t/b" 2026.10.8 > /dev/null 2> "$t/err" || { echo "FAIL render without tls"; fail=1; }
eq "stderr without tls" "$(cat "$t/err")" "formula.sh: agentglass-receive-tls in: none"
# refusals: a bad version, a missing checksum, an archive without agentglass
sh "$here/scripts/formula.sh" "$t/a" v2026.10.8 > /dev/null 2>&1 && { echo "FAIL a tag instead of a version accepted"; fail=1; }
grep -v linux-arm64 "$t/a/SHA256SUMS" > "$t/s" && cp "$t/s" "$t/a/SHA256SUMS"
o=$(sh "$here/scripts/formula.sh" "$t/a" 2026.10.8 2>&1 > /dev/null) && { echo "FAIL a missing checksum accepted"; fail=1; }
has "missing checksum named" "$o" "no checksum for agentglass-linux-arm64.tar.gz"
assets "$t/c"; mkdir -p "$t/c/x"; printf x > "$t/c/x/other"; tar -czf "$t/c/agentglass-darwin-x64.tar.gz" -C "$t/c/x" other; (cd "$t/c" && $H agentglass-*.tar.gz | sort -k2 > SHA256SUMS)
o=$(sh "$here/scripts/formula.sh" "$t/c" 2026.10.8 2>&1 > /dev/null) && { echo "FAIL an archive without agentglass accepted"; fail=1; }
has "archive without agentglass named" "$o" "agentglass-darwin-x64.tar.gz has no agentglass"
[ $fail = 0 ] && echo "formula: all tests passed"
exit $fail
