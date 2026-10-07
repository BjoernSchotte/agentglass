#!/bin/sh
# end-to-end tests for `agentglass update` against file:// fixture releases (two real builds): sh scripts/update.test.sh
# check: builds 2 (shard weight for scripts/check-plan.mjs)
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR # hermetic: the fake HOME decides, not the caller's overrides
export AGENTGLASS_AGENT=0 # human-mode behavior, also when the suite runs inside a coding agent
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; chmod -R u+w "$t" 2>/dev/null; rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
os=$(uname -s | tr 'A-Z' 'a-z'); case "$(uname -m)" in x86_64|amd64) arch=x64;; aarch64|arm64) arch=arm64;; esac
plat="$os-$arch"; asset="agentglass-$plat.tar.gz"
if command -v sha256sum >/dev/null 2>&1; then H="sha256sum"; else H="shasum -a 256"; fi
# each build gets a private source copy (its build-info.ts) and output directory (scriptc writes main.ll beside the
# binary), so both run at once and src/ stays untouched
build() { mkdir -p "$4.src" && cp -R "$here/src/." "$4.src/" && AGENTGLASS_SRC="$4.src" AGENTGLASS_VERSION="$1" AGENTGLASS_CHANNEL="$2" AGENTGLASS_COMMIT="$3" AGENTGLASS_OUT="$4.src/agentglass" sh "$here/build.sh" > "$4.log" 2>&1 && mv "$4.src/agentglass" "$4" || { cat "$4.log"; return 1; }; }
build 2026.9.1 stable 1111111111111111111111111111111111111111 "$t/old" & b1=$!
build 2026.9.2 stable 2222222222222222222222222222222222222222 "$t/new" & b2=$!
wait $b1 || exit 1; wait $b2 || exit 1
fake() { printf '#!/bin/sh\nif [ "$2" = --json ]; then echo '"'"'{"version":"%s","channel":"%s"}'"'"'; else echo %s; fi\n' "$1" "$2" "$1" > "$3"; chmod 755 "$3"; }
rel() { # rel <tag> <binary> <version> <channel> [corrupt]
  d="$t/dl/$1"; mkdir -p "$d/x"; cp "$2" "$d/x/agentglass"; tar -czf "$d/$asset" -C "$d/x" agentglass; rm -rf "$d/x"
  (cd "$d" && $H "$asset" > SHA256SUMS); [ "${5:-}" = corrupt ] && echo x >> "$d/$asset"
  printf '{"schema":"agentglass.build-metadata/v1","version":"%s","channel":"%s","tag":"%s"}\n' "$3" "$4" "$1" > "$d/build-metadata.json"
}
api() { # api <file> <tag:pre>...
  f="$1"; shift; printf '[' > "$f"; sep=""
  for x in "$@"; do printf '%s{"tag_name":"%s","prerelease":%s,"draft":false,"assets":[{"name":"%s"},{"name":"SHA256SUMS"},{"name":"build-metadata.json"}]}' "$sep" "${x%%:*}" "${x##*:}" "$asset" >> "$f"; sep=","; done
  printf ']' >> "$f"
}
rel v2026.9.2 "$t/new" 2026.9.2 stable
rel v2026.9.1 "$t/old" 2026.9.1 stable
rel v2026.9.3 "$t/new" 2026.9.3 stable corrupt
fake 2026.9.9 stable "$t/liar"; rel v2026.9.4 "$t/liar" 2026.9.4 stable
fake 2026.9.1-dev.20260930.3+a1b2c3d4 dev "$t/devbin"; rel dev-20260930.3.1-a1b2c3d4 "$t/devbin" 2026.9.1-dev.20260930.3+a1b2c3d4 dev
api "$t/good.json" v2026.9.2:false v2026.9.1:false dev-20260930.3.1-a1b2c3d4:true
api "$t/corrupt.json" v2026.9.3:false
api "$t/liar.json" v2026.9.4:false
mkdir -p "$t/home" "$t/bin"; cp "$t/old" "$t/bin/agentglass"
printf '{"method":"script","channel":"stable","path":"%s","version":"2026.9.1"}\n' "$t/bin/agentglass" > "$t/home/install.json"; mkdir -p "$t/home/.agentglass"; mv "$t/home/install.json" "$t/home/.agentglass/"
export AGENTGLASS_DOWNLOAD_BASE="file://$t/dl"
ag() { f="$1"; shift; HOME="$t/home" AGENTGLASS_RELEASES_API="file://$t/$f" "$t/bin/agentglass" update "$@" > "$t/out" 2>&1 < /dev/null; }
v() { "$t/bin/agentglass" --version; }
code() { if "$@"; then echo 0; else echo $?; fi; }

eq "dry-run exit" "$(code ag good.json --dry-run --json)" 0
grep -q '"tag":"v2026.9.2"' "$t/out" || { echo "FAIL dry-run target: $(cat "$t/out")"; fail=1; }
eq "dry-run leaves binary" "$(v)" "2026.9.1"
printf '#!/bin/sh\necho 2026.9.1\n' > "$t/bin/agentglass-receive-tls"; chmod 755 "$t/bin/agentglass-receive-tls" # the old version's HTTPS receiver
eq "update exit" "$(code ag good.json)" 0
eq "updated" "$(v)" "2026.9.2"
[ ! -e "$t/bin/agentglass-receive-tls" ] || { echo "FAIL a release without agentglass-receive-tls left the old one"; fail=1; }
grep -q "old one is removed" "$t/out" || { echo "FAIL no note about the removed agentglass-receive-tls: $(cat "$t/out")"; fail=1; }
eq "prev kept" "$("$t/bin/agentglass.prev" --version)" "2026.9.1"
grep -q '"channel": *"stable"' "$t/home/.agentglass/config.json" || { echo "FAIL channel persisted: $(cat "$t/home/.agentglass/config.json" 2>&1)"; fail=1; }
grep -q '"version":"2026.9.2"' "$t/home/.agentglass/install.json" || { echo "FAIL install.json version"; fail=1; }
eq "up to date exit" "$(code ag good.json)" 0
grep -qi "already" "$t/out" || { echo "FAIL up-to-date message: $(cat "$t/out")"; fail=1; }
eq "rollback exit" "$(code ag good.json --rollback)" 0
eq "rolled back" "$(v)" "2026.9.1"
eq "corrupt exit" "$(code ag corrupt.json)" 1
grep -qi "checksum" "$t/out" || { echo "FAIL corrupt message: $(cat "$t/out")"; fail=1; }
eq "corrupt unchanged" "$(v)" "2026.9.1"
eq "liar exit" "$(code ag liar.json)" 1
grep -qi "self-check" "$t/out" || { echo "FAIL liar message: $(cat "$t/out")"; fail=1; }
eq "liar unchanged" "$(v)" "2026.9.1"
eq "no work dirs left" "$(ls -A "$t/bin" | grep -c '^\.agentglass-update' || true)" 0
ag good.json >/dev/null 2>&1 || true
eq "back on 2026.9.2" "$(v)" "2026.9.2"
eq "non-tty downgrade refused" "$(code ag good.json --channel dev)" 2
grep -qi "downgrade" "$t/out" || { echo "FAIL downgrade message: $(cat "$t/out")"; fail=1; }
eq "downgrade unchanged" "$(v)" "2026.9.2"
eq "downgrade with --yes" "$(code ag good.json --channel dev --yes)" 0
eq "on dev" "$(v)" "2026.9.1-dev.20260930.3+a1b2c3d4"
grep -q '"channel": *"dev"' "$t/home/.agentglass/config.json" || { echo "FAIL dev channel persisted"; fail=1; }
mkdir -p "$t/Cellar/agentglass/2026.9.1/bin"; cp "$t/old" "$t/Cellar/agentglass/2026.9.1/bin/agentglass"
eq "brew refused" "$(code env HOME="$t/home" AGENTGLASS_RELEASES_API="file://$t/good.json" "$t/Cellar/agentglass/2026.9.1/bin/agentglass" update)" 2
mkdir -p "$t/ro"; cp "$t/old" "$t/ro/agentglass"; printf '{"method":"script","channel":"stable","path":"%s","version":"2026.9.1"}\n' "$t/ro/agentglass" > "$t/home/.agentglass/install.json"; chmod 555 "$t/ro"
eq "read-only dir" "$(code env HOME="$t/home" AGENTGLASS_RELEASES_API="file://$t/good.json" "$t/ro/agentglass" update --channel stable)" 1
eq "read-only unchanged" "$("$t/ro/agentglass" --version)" "2026.9.1"
# install.json written with a symlinked path (macOS: /var → /private/var) must still be recognised and updated
mkdir -p "$t/real/bin"; ln -s "$t/real" "$t/link"; cp "$t/old" "$t/real/bin/agentglass"
printf '{"method":"script","channel":"stable","path":"%s","version":"2026.9.1"}\n' "$t/link/bin/agentglass" > "$t/home/.agentglass/install.json"
rm -f "$t/home/.agentglass/config.json"
eq "symlinked install method" "$(HOME="$t/home" "$t/link/bin/agentglass" --version --json | sed -n 's/.*"installMethod":"\([a-z]*\)".*/\1/p')" "script"
if HOME="$t/home" AGENTGLASS_RELEASES_API="file://$t/good.json" "$t/link/bin/agentglass" update > /dev/null; then r=0; else r=$?; fi; eq "symlinked update" "$r" 0
grep -q '"version":"2026.9.2"' "$t/home/.agentglass/install.json" || { echo "FAIL symlinked install.json version: $(cat "$t/home/.agentglass/install.json")"; fail=1; }
# --tag is one-off: installs that release but never changes the saved channel
printf '{"update":{"channel":"stable"}}' > "$t/home/.agentglass/config.json"
cp "$t/new" "$t/real/bin/agentglass"
if HOME="$t/home" AGENTGLASS_RELEASES_API="file://$t/good.json" "$t/real/bin/agentglass" update --tag dev-20260930.3.1-a1b2c3d4 --yes > /dev/null; then r=0; else r=$?; fi
eq "tag install exit" "$r" 0
eq "tag installed" "$("$t/real/bin/agentglass" --version)" "2026.9.1-dev.20260930.3+a1b2c3d4"
grep -q '"channel": *"stable"' "$t/home/.agentglass/config.json" || { echo "FAIL --tag persisted the channel: $(cat "$t/home/.agentglass/config.json")"; fail=1; }
# status works on Homebrew installs too (it only reads)
if HOME="$t/home" AGENTGLASS_RELEASES_API="file://$t/good.json" "$t/Cellar/agentglass/2026.9.1/bin/agentglass" update status --json > "$t/st"; then r=0; else r=$?; fi
eq "brew status" "$r" 0
grep -q '"installMethod":"homebrew"' "$t/st" && grep -q '"latest":"v2026.9.2"' "$t/st" || { echo "FAIL brew status content: $(cat "$t/st")"; fail=1; }
[ $fail = 0 ] && echo "update: all e2e tests passed"; exit $fail
