#!/bin/sh
# check.sh reports each passing job with its own summary line: shell job-status noise after it ("Terminated", bash's
# "line 9: 123 Terminated  sleep 9", "Killed") and trailing blank lines are skipped
set -e
cd "$(dirname "$0")/.."
d=$(mktemp -d); trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; rm -rf "$d"' EXIT
fail=0
t() { # t <name> <want> <log lines…>
  n=$1; want=$2; shift 2; printf '%s\n' "$@" > "$d/log"
  got=$(sh scripts/check.sh --summary "$d/log")
  [ "$got" = "$want" ] || { echo "FAIL $n: got '$got' want '$want'"; fail=1; }
}
t plain "x: all checks passed" "noise" "x: all checks passed"
t terminated "x: all checks passed" "x: all checks passed" "Terminated"
t bash-style "x: ok" "x: ok" "scripts/x.test.sh: line 9: 12345 Terminated              sleep 9" ""
t killed "x: ok" "x: ok" "Killed" "Hangup"
t only-noise "Terminated" "Terminated"
printf '' > "$d/log"; got=$(sh scripts/check.sh --summary "$d/log"); [ -z "$got" ] || { echo "FAIL empty: '$got'"; fail=1; }
[ $fail = 0 ] && echo "check summary: all tests passed"
exit $fail
