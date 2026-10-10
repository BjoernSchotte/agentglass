#!/bin/sh
# build the native binary (scriptc needs Node 24+ to build, not to run)
set -e
cd "$(dirname "$0")"
. ./scripts/toolchain.sh
sh scripts/build-info.sh
# SCRIPTC_FLAGS: extra flags, e.g. --backend c where scriptc ships no LLVM helper (macOS x64)
# AGENTGLASS_SRC: build another source tree (see scripts/build-info.sh)
# every OS: the team crypto (features/team/crypto/ffi.json: Monocypher); macOS also the libproc bindings
# (platform/darwin/ffi.json: processes without ps/lsof). A tree without a manifest builds without it, as before.
# scriptc takes one --ffi (a second replaces the first): two manifests are merged into one (scripts/ffi-merge.mjs)
ms=""; t="${AGENTGLASS_SRC:-src}/features/team/crypto/ffi.json"; m="${AGENTGLASS_SRC:-src}/platform/darwin/ffi.json"
if [ -f "$t" ]; then ms="$t"; fi
if [ "$(uname -s)" = Darwin ] && [ -f "$m" ]; then ms="$ms $m"; fi
ffi=""; case "$ms" in
  *" "*) mf=$(mktemp "${TMPDIR:-/tmp}/agentglass-ffi.XXXXXX"); trap 'rm -f "$mf"' EXIT
         node scripts/ffi-merge.mjs "$mf" $ms; ffi="--ffi $mf" ;;
  ?*) ffi="--ffi $ms" ;;
esac
scriptc build ${SCRIPTC_FLAGS:-} $ffi "${AGENTGLASS_SRC:-src}/main.ts" -o "${AGENTGLASS_OUT:-agentglass}"
# agentglass-mcp, the MCP server (src/mcp only: no feature module, no FFI), beside agentglass unless AGENTGLASS_MCP_OUT
scriptc build ${SCRIPTC_FLAGS:-} "${AGENTGLASS_SRC:-src}/mcp/main.ts" -o "${AGENTGLASS_MCP_OUT:-$(dirname "${AGENTGLASS_OUT:-agentglass}")/agentglass-mcp}"
