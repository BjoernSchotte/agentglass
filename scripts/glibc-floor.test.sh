#!/bin/sh
# tests for glibc-floor.sh with a fake objdump: sh scripts/glibc-floor.test.sh
set -e
here=$(cd "$(dirname "$0")" && pwd); t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail=0
fake() { printf '#!/bin/sh\ncat <<EOT\n%s\nEOT\n' "$1" > "$t/objdump"; chmod 755 "$t/objdump"; }
chk() { OBJDUMP="$t/objdump" sh "$here/glibc-floor.sh" /bin/true "$1" > "$t/out" 2>&1; }
fake "0000 DF *UND* 0000 (GLIBC_2.2.5) fmod
0000 DF *UND* 0000 (GLIBC_2.36) pidfd_open
0000 DF *UND* 0000 (GLIBC_2.17) clock_gettime"
chk 2.36 || { echo "FAIL 2.36 binary under a 2.36 floor: $(cat "$t/out")"; fail=1; }
fake "0000 DF *UND* 0000 (GLIBC_2.38) fmod
0000 DF *UND* 0000 (GLIBC_2.36) pidfd_open"
if chk 2.36; then echo "FAIL 2.38 binary passed a 2.36 floor"; fail=1; fi
grep -q "fmod" "$t/out" && grep -q "2.38" "$t/out" || { echo "FAIL message names the symbol: $(cat "$t/out")"; fail=1; }
fake "0000 DF *UND* 0000 (GLIBC_2.4) memcpy
0000 DF *UND* 0000 (GLIBC_2.10) foo"
chk 2.9 && { echo "FAIL 2.10 > 2.9 must fail (numeric, not lexical)"; fail=1; } || true
chk 2.36 || { echo "FAIL 2.10 under 2.36 must pass"; fail=1; }
[ $fail = 0 ] && echo "glibc-floor: all tests passed"; exit $fail
