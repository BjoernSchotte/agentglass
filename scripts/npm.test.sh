#!/bin/sh
# the npm packages, installed as a user would (local tarballs, offline): the launcher runs this platform's binary and
# passes its exit status; without the platform package (--omit=optional) it names the missing package; no package has
# a scripts field. Needs dist/agentglass-web-<this platform>.tar.gz (scripts/build-web.sh) and npm.
#   sh scripts/npm.test.sh [<version>]   (default: the version the archive was built with)
set -e
v="${1:-}"; here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; rm -rf "$t"' EXIT
command -v npm > /dev/null || { echo "npm.test.sh: skipped (no npm)"; exit 0; }
case "$(uname -s)-$(uname -m)" in Linux-x86_64) p=linux-x64 ;; Linux-aarch64) p=linux-arm64 ;; Darwin-arm64) p=darwin-arm64 ;; Darwin-x86_64) p=darwin-x64 ;; esac
[ -f "$here/dist/agentglass-web-$p.tar.gz" ] || { echo "npm.test.sh: skipped (no dist/agentglass-web-$p.tar.gz: sh scripts/build-web.sh <version> $p)"; exit 0; }
# no version given (check.sh): the one the archive was built with
[ -n "$v" ] || { mkdir "$t/v" && tar -xzf "$here/dist/agentglass-web-$p.tar.gz" -C "$t/v" agentglass-web && v=$("$t/v/agentglass-web" --version | sed 's/^agentglass-web //'); }
fail=0
sh "$here/scripts/npm-pack.sh" "$v" "$here/dist" "$t/out" "$p" > /dev/null
for f in "$t"/out/*.tgz; do tar -xzf "$f" -O package/package.json | grep -q '"scripts"' && { echo "FAIL $(basename "$f") has a scripts field"; fail=1; }; done
main="$t/out/agentglass-web-$v.tgz"; plat=$(ls "$t"/out/agentglass-web-*-"$v".tgz | head -1)
mkdir -p "$t/a" && (cd "$t/a" && npm init -y > /dev/null && npm i --offline --no-audit --no-fund "$plat" "$main" > "$t/a.log" 2>&1) || { echo "FAIL install: $(tail -5 "$t/a.log")"; fail=1; }
got=$("$t/a/node_modules/.bin/agentglass-web" --version 2>&1) || true
[ "$got" = "agentglass-web $v" ] || { echo "FAIL launcher --version: '$got'"; fail=1; }
set +e; "$t/a/node_modules/.bin/agentglass-web" --nope > /dev/null 2>&1; rc=$?; set -e
[ "$rc" = 2 ] || { echo "FAIL exit status not passed through: $rc"; fail=1; }
mkdir -p "$t/b" && (cd "$t/b" && npm init -y > /dev/null && npm i --offline --omit=optional --no-audit --no-fund "$main" > "$t/b.log" 2>&1) || { echo "FAIL install --omit=optional: $(tail -5 "$t/b.log")"; fail=1; }
set +e; msg=$("$t/b/node_modules/.bin/agentglass-web" --version 2>&1); rc=$?; set -e
[ "$rc" = 1 ] && echo "$msg" | grep -q "agentglass-web-$p\|agentglass-web-darwin-x64-baseline" && echo "$msg" | grep -q "omit=optional" || { echo "FAIL missing platform package message (exit $rc): $msg"; fail=1; }
[ $fail = 0 ] && echo "npm.test.sh: ok"; exit $fail
