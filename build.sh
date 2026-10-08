#!/bin/sh
# build the native binary (scriptc needs Node 24+ to build, not to run)
set -e
cd "$(dirname "$0")"
. ./scripts/toolchain.sh
sh scripts/build-info.sh
# SCRIPTC_FLAGS: extra flags, e.g. --backend c where scriptc ships no LLVM helper (macOS x64)
# AGENTGLASS_SRC: build another source tree (see scripts/build-info.sh)
# macOS: the libproc bindings (platform/darwin/ffi.json: processes without ps/lsof); a tree without them builds as before
ffi=""; m="${AGENTGLASS_SRC:-src}/platform/darwin/ffi.json"
if [ "$(uname -s)" = Darwin ] && [ -f "$m" ]; then ffi="--ffi $m"; fi
scriptc build ${SCRIPTC_FLAGS:-} $ffi "${AGENTGLASS_SRC:-src}/main.ts" -o "${AGENTGLASS_OUT:-agentglass}"
# agentglass-mcp, the MCP server (src/mcp only: no feature module, no FFI), beside agentglass unless AGENTGLASS_MCP_OUT
scriptc build ${SCRIPTC_FLAGS:-} "${AGENTGLASS_SRC:-src}/mcp/main.ts" -o "${AGENTGLASS_MCP_OUT:-$(dirname "${AGENTGLASS_OUT:-agentglass}")/agentglass-mcp}"
