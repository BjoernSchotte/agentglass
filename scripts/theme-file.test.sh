#!/bin/sh
# AGENTGLASS_THEME_FILE moves the persisted theme like the other overrides, so test runs never touch ~/.agentglass/theme:
# sh scripts/theme-file.test.sh
set -e
unset AGENTGLASS_THEME AGENTGLASS_THEME_FILE
export AGENTGLASS_AGENT=0
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/ag"; else AGENTGLASS_OUT="$t/ag" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
mkdir -p "$t/home/.agentglass"
cur() { HOME="$t/home" AGENTGLASS_OFFLINE=1 AGENTGLASS_NOTIFY=0 "$@" "$t/ag" --theme list | sed -n 's/^\* //p'; }

printf 'dracula\n' > "$t/home/.agentglass/theme"
printf 'catppuccin-latte\n' > "$t/other-theme"
eq "default file" "$(cur env)" "dracula"
eq "override file" "$(cur env AGENTGLASS_THEME_FILE="$t/other-theme")" "catppuccin-latte"
eq "override file missing: default theme, not ~/.agentglass/theme" "$(cur env AGENTGLASS_THEME_FILE="$t/none")" \
  "$(HOME="$t/empty" AGENTGLASS_OFFLINE=1 "$t/ag" --theme list | sed -n 's/^\* //p')"
eq "AGENTGLASS_THEME beats the file" "$(cur env AGENTGLASS_THEME_FILE="$t/other-theme" AGENTGLASS_THEME=dracula)" "dracula"

[ $fail = 0 ] && echo "ok theme-file"
exit $fail
