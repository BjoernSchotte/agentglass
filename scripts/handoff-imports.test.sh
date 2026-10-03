#!/bin/sh
# links only open views: the hand-off's apply path (apply.ts, open.ts) imports only an allowlist and names no action
# that sends, resumes, kills, trashes, exports or answers a dialog
set -e
cd "$(dirname "$0")/.."
fail=0
check() { # file, allowed specifiers (space separated)
  for spec in $(grep -o 'from "[^"]*"' "$1" | sed 's/from "\(.*\)"/\1/'); do
    case " $2 " in *" $spec "*) ;; *) echo "FAIL $1 imports $spec"; fail=1 ;; esac
  done
  if grep -nE 'actions\.ts|otlp|update\.ts|sendPrompt|resume\(|killPid|trash\(|confirm\(|sendTmux|onInput' "$1"; then echo "FAIL $1 names a side effect"; fail=1; fi
}
[ -f src/features/palette/apply.ts ] && [ -f src/features/palette/open.ts ] || { echo "FAIL apply.ts / open.ts missing"; exit 1; }
check src/features/palette/apply.ts "../../state.ts ./ref.ts ./open.ts ./view.ts ../../model/sessions.ts"
check src/features/palette/open.ts "node:fs node:path ../../platform/index.ts ./instance.ts ../../model/types.ts ../../state.ts ../../hooks.ts ../../model/sessions.ts ../../ui/transcript.ts ../../util/json.ts ./ref.ts ./handoff.ts ./rundir.ts ./spool.ts ../agentenv.ts ../clihelp.ts ../../util/config.ts ./urlhandler.ts"
[ $fail = 0 ] && echo "handoff imports: allowlist holds"
exit $fail
