#!/bin/sh
# live sessions through the kernel process scan (Linux /proc, macOS libproc) equal those through ps: three fake agents
# (scripts/fixture-agents.sh), one per link method (Claude registry, Codex open rollout, Gemini cwd), read with and
# without AGENTGLASS_PROCS=ps: sh scripts/procs-parity.test.sh (uses AGENTGLASS_BIN)
set -e
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); t=$(cd "$t" && pwd -P)
trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; sh "$here/scripts/fixture-agents.sh" stop "$t/fx" > /dev/null 2>&1 || true; rm -rf "$t"' EXIT
fail=0
sh "$here/scripts/fixture-agents.sh" start "$t/fx" --agents 3 --history 2 --background 0 > /dev/null
h="$t/fx/home"; cl=$(head -n 1 "$t/fx/agents")
i=0; while [ ! -f "$h/.claude/sessions/$cl.json" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
mkdir -p "$t/run"; chmod 700 "$t/run"
live() { # live [ps]: the session rows as CSV, sorted (HOME: $lh, default $h)
  env -i HOME="${lh:-$h}" PATH="$PATH" AGENTGLASS_AGENT=0 AGENTGLASS_NOTIFY=0 AGENTGLASS_OFFLINE=1 AGENTGLASS_CACHE_DIR="$t/cache-${1:-native}${lh:+-ln}" \
    AGENTGLASS_CONFIG="$t/config.json" AGENTGLASS_RULES="$t/rules.json" AGENTGLASS_RUN_DIR="$t/run" AGENTGLASS_PALETTE_FILE="$t/palette.json" \
    AGENTGLASS_THEME_FILE="$t/theme" AGENTGLASS_PRICES="$t/prices.json" AGENTGLASS_OTLP_DIR="$t/otlp" ${1:+AGENTGLASS_PROCS=ps} \
    "$AGENTGLASS_BIN" --json --fields id,harness,live,pid,status --format csv | sort
}
a=$(live ps); b=$(live)
[ "$a" = "$b" ] || { echo "FAIL ps and native differ:"; echo "--- AGENTGLASS_PROCS=ps"; echo "$a"; echo "--- native"; echo "$b"; fail=1; }
n=$(printf '%s\n' "$b" | grep -c ',true,' || true)
[ "$n" = 3 ] || { echo "FAIL live rows: $n, want 3"; echo "$b"; fail=1; }
for hn in claude codex gemini; do printf '%s\n' "$b" | grep ",$hn,true," > /dev/null || { echo "FAIL no live $hn session"; fail=1; }; done
# HOME through a symlink (macOS mktemp: /var → /private/var): the kernel names Codex's open rollout by its real path,
# the session is keyed under HOME — still linked
ln -s . "$t/ln"; lh="$t/ln/fx/home"; c=$(live); lh=""
n=$(printf '%s\n' "$c" | grep -c ',true,' || true)
[ "$n" = 3 ] || { echo "FAIL live rows, HOME via a symlink: $n, want 3"; echo "$c"; fail=1; }
[ $fail = 0 ] && echo "procs parity cli: all checks passed"
exit $fail
