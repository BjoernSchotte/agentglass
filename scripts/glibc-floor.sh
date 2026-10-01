#!/bin/sh
# glibc-floor.sh <binary> <max>: fail when the binary needs a glibc symbol version newer than <max> (e.g. 2.36)
# keeps Linux builds runnable on the oldest glibc we promise; OBJDUMP overrides the tool (tests)
bin="$1"; max="$2"
"${OBJDUMP:-objdump}" -T "$bin" | sed -n 's/.*(GLIBC_\([0-9][0-9.]*\)) *\([^ ]*\).*/\1 \2/p' |
  awk -v max="$max" '
    function cmp(a, b,   x, y, i, n) { n = split(a, x, "."); split(b, y, "."); if (n < 2) n = 2
      for (i = 1; i <= n; i++) if ((x[i] + 0) != (y[i] + 0)) return (x[i] + 0) < (y[i] + 0) ? -1 : 1; return 0 }
    cmp($1, max) > 0 { print "glibc-floor: " $2 " needs GLIBC_" $1 " (> " max ")"; bad = 1 }
    END { exit bad }' >&2
