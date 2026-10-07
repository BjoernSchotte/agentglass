#!/bin/sh
# EXIT traps that clean up run in the test's own shell only. bash (macOS's /bin/sh) runs the parent's EXIT trap in a
# child that gets SIGTERM between its fork and its exec (`sleep 600 & a=$!; kill $a`): the child deleted the test's temp
# dir under the still-running test (otlp-filter.test.sh, macOS CI). Every trap therefore starts with the guard
#   [ "$(exec sh -c "echo \$PPID")" = $$ ] || exit
# ($$ is the script's pid in every subshell; sh's parent is the shell that really runs the trap). Checks: every script
# with an EXIT trap has it, and with it a fork-then-kill storm leaves the dir alone in sh, bash and dash:
# sh scripts/trap-guard.test.sh
set -e
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; rm -rf "$t"' EXIT
fail=0
for f in "$here"/scripts/*.sh; do # (install.sh starts no background job: no child can inherit its trap)
  grep -qE '^[^#]*trap .*EXIT' "$f" || continue
  grep -qF '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit' "$f" || { echo "FAIL $(basename "$f"): EXIT trap without the own-shell guard"; fail=1; }
done
# storm <shell> <guarded|bare>: 100 children killed right after their fork (a short sleep: bash can lose a TERM that lands
# before its exec, the sleep then runs on); prints how many of them ran the trap and
# whether the dir was still there when the loop ended
cat > "$t/storm.sh" <<'SH'
d=$1; n=$2; mkdir -p "$d"; : > "$n"
if [ "$3" = guarded ]; then trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; rm -rf "$d"' EXIT
else trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || echo child >> "$n"; rm -rf "$d"' EXIT; fi
i=0; while [ $i -lt 100 ]; do sleep 1 & a=$!; kill $a; wait $a 2> /dev/null || true; i=$((i + 1)); done
[ -d "$d" ] && echo kept || echo gone
SH
storm() { k=$($1 "$t/storm.sh" "$t/storm" "$t/children" $2 2> /dev/null || true); echo "$(wc -l < "$t/children" | tr -d ' ') $k"; }
for sh in sh bash dash; do
  command -v $sh > /dev/null 2>&1 || continue
  set -- $(storm $sh guarded)
  [ "$2" = kept ] || { echo "FAIL $sh: the dir went while the shell ran, with the guard"; fail=1; }
  [ ! -d "$t/storm" ] || { echo "FAIL $sh: the shell's own trap left the dir"; fail=1; }
  set -- $(storm $sh bare)
  echo "$sh: without the guard $1 of 100 children killed before their exec ran the trap (dir $2)"
done
[ $fail = 0 ] && echo "trap guard: ok"
exit $fail
