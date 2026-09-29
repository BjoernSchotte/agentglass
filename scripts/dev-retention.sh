#!/bin/sh
# dev tags on stdin → the ones to delete, oldest first: all dev-* beyond the newest <keep> by (date, run, attempt), never <pinned>
# keep 0 lists every dev tag ascending (the last line is the newest)
keep="$1"; pinned="$2"
sed -n 's/^\(dev-\([0-9]\{8\}\)\.\([0-9][0-9]*\)\.\([0-9][0-9]*\)-[0-9a-f]\{8\}\)$/\2 \3 \4 \1/p' |
  sort -k1,1n -k2,2n -k3,3n | cut -d' ' -f4 |
  awk -v k="$keep" -v p="$pinned" '{ a[NR] = $0 } END { n = (k == 0) ? NR : NR - k; for (i = 1; i <= n; i++) if (a[i] != p) print a[i] }'
