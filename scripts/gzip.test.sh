#!/bin/sh
# pure-TS gzip (src/util/gzip.ts) against the system gzip: every output decodes to its input: sh scripts/gzip.test.sh
set -e
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
. "$here/scripts/toolchain.sh"
scriptc build "$here/testdata/otlp/gzip-driver.ts" -o "$t/gz" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }
fail=0
check() { "$t/gz" "$t/$1" "$t/$1.gz" && gzip -dc "$t/$1.gz" | cmp -s - "$t/$1" || { echo "FAIL $1"; fail=1; }; }
: > "$t/empty"; check empty
printf 'x' > "$t/one"; check one
awk 'BEGIN { for (i = 0; i < 102400; i++) printf "a" }' > "$t/aaaa"; check aaaa
head -c 1048576 /dev/urandom > "$t/random"; check random
# a 4 MB OTLP-like batch
awk 'BEGIN { for (i = 0; i < 16000; i++) printf "{\"traceId\":\"%032x\",\"spanId\":\"%016x\",\"name\":\"execute_tool Bash git\",\"attributes\":[{\"key\":\"gen_ai.tool.call.id\",\"value\":{\"stringValue\":\"toolu_%d\"}}]},", i * 7919, i, i }' > "$t/batch"; check batch
# repeats that straddle the 32 KB window edge (distances near 32768, matches across the boundary)
head -c 32760 /dev/urandom > "$t/blk"; cat "$t/blk" "$t/blk" "$t/blk" > "$t/edge"; head -c 70000 "$t/edge" > "$t/edge70"; check edge70
# random data does not shrink: the exporter then sends it plain
r=$(wc -c < "$t/random"); z=$(wc -c < "$t/random.gz"); [ "$z" -ge "$r" ] || { echo "FAIL random shrank"; fail=1; }
[ $fail = 0 ] && echo "gzip round trips: ok"
exit $fail
