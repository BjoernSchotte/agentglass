#!/bin/sh
# build the native binary (scriptc needs Node 24+ to build, not to run)
set -e
cd "$(dirname "$0")"
. ./scripts/toolchain.sh
sh scripts/build-info.sh
# SCRIPTC_FLAGS: extra flags, e.g. --backend c where scriptc ships no LLVM helper (macOS x64)
# AGENTGLASS_SRC: build another source tree (see scripts/build-info.sh)
scriptc build ${SCRIPTC_FLAGS:-} "${AGENTGLASS_SRC:-src}/main.ts" -o "${AGENTGLASS_OUT:-agentglass}"
