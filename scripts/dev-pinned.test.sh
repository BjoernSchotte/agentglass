#!/bin/sh
# tests for dev-pinned.sh with a fake gh: sh scripts/dev-pinned.test.sh
set -e
here=$(cd "$(dirname "$0")" && pwd); t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail=0; mkdir -p "$t/bin"
cat > "$t/bin/gh" <<'EOG'
#!/bin/sh
case "$MODE" in
  ok) echo '{"schema":"agentglass.homebrew-dev-pointer/v1","tag":"dev-20261005.12.1-a1b2c3d4","version":"x"}' ;;
  missing) echo '{"message":"Not Found","status":"404"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
  error) echo "gh: HTTP 502" >&2; exit 1 ;;
  garbage) echo '{"schema":"agentglass.homebrew-dev-pointer/v1"}' ;;
esac
EOG
chmod +x "$t/bin/gh"
pin() { MODE="$1" PATH="$t/bin:$PATH" sh "$here/dev-pinned.sh" 2>/dev/null; }
[ "$(pin ok)" = "dev-20261005.12.1-a1b2c3d4" ] || { echo "FAIL ok"; fail=1; }
if out=$(pin missing); then [ -z "$out" ] || { echo "FAIL missing should print nothing"; fail=1; }; else echo "FAIL missing pointer must be ok (no pin yet)"; fail=1; fi
if pin error >/dev/null; then echo "FAIL API error must abort"; fail=1; fi
if pin garbage >/dev/null; then echo "FAIL pointer without tag must abort"; fail=1; fi
[ $fail = 0 ] && echo "dev-pinned: all tests passed"; exit $fail
