#!/bin/sh
# tests for dev-retention.sh: sh scripts/dev-retention.test.sh
set -e
here=$(cd "$(dirname "$0")" && pwd); fail=0
eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
tags() { # 20 dev tags over 3 days, runs/attempts mixed, plus noise
  for i in 1 2 3 4 5 6 7; do echo "dev-20260928.$i.1-aaaaaaa$i"; done
  echo "dev-20260928.7.2-bbbbbbb7"
  for i in 8 9 10 11 12 13; do echo "dev-20260929.$i.1-ccccccc$((i % 10))"; done
  for i in 14 15 16 17 18 19; do echo "dev-20260930.$i.1-ddddddd$((i % 10))"; done
  echo "v2026.9.1"; echo "nightly"; echo "dev-2026093.1.1-deadbeef"
}
del=$(tags | sh "$here/dev-retention.sh" 14 "")
eq "count" "$(echo "$del" | grep -c .)" "6"
eq "oldest first" "$(echo "$del" | head -1)" "dev-20260928.1.1-aaaaaaa1"
eq "keeps attempt 2 over 1" "$(echo "$del" | grep -c 'dev-20260928.7.2')" "0"
eq "deletes attempt 1" "$(echo "$del" | tail -1)" "dev-20260928.6.1-aaaaaaa6"
pinned=$(tags | sh "$here/dev-retention.sh" 14 "dev-20260928.3.1-aaaaaaa3")
eq "pinned kept" "$(echo "$pinned" | grep -c 'dev-20260928.3.1')" "0"
eq "pinned count" "$(echo "$pinned" | grep -c .)" "5"
eq "few tags" "$(printf 'dev-20260930.1.1-aaaaaaaa\n' | sh "$here/dev-retention.sh" 14 "")" ""
eq "noise ignored" "$(tags | sh "$here/dev-retention.sh" 0 "" | grep -c 'v2026\|nightly\|2026093\.')" "0"
eq "keep 0 lists all ascending" "$(tags | sh "$here/dev-retention.sh" 0 "" | tail -1)" "dev-20260930.19.1-ddddddd9"
[ $fail = 0 ] && echo "dev-retention: all tests passed"; exit $fail
