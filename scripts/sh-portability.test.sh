#!/bin/sh
# no `VAR=x fn` (an assignment before a shell function call) in scripts/*.sh: macOS sh (bash 3.2 --posix) keeps the
# assignment after the call returns, dash and bash 5 do not; run it in a subshell instead: (VAR=x fn): sh scripts/sh-portability.test.sh
here=$(cd "$(dirname "$0")/.." && pwd); fail=0
for f in "$here"/scripts/*.sh; do
  fns=$(grep -oE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*\(\)' "$f" | tr -d ' ()\t' | sort -u | paste -sd'|' -)
  [ -n "$fns" ] || continue
  w="([^[:space:];&|()\"']*|\"[^\"]*\"|'[^']*')" # one assignment's value
  # a command position (line start, after ; && || | { ! then do else), one or more NAME=value, then a function name
  if grep -nE "(^|[;&|{!]|then|do|else)[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=$w[[:space:]]+)+($fns)([[:space:];)>]|$)" "$f"; then
    echo "FAIL $(basename "$f"): assignment before a function call above: wrap it in a subshell"; fail=1
  fi
done
[ $fail = 0 ] && echo "sh portability: all checks passed"
exit $fail
