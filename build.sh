#!/bin/sh
# build the native binary (scriptc needs Node 24+ to build, not to run)
set -e
cd "$(dirname "$0")"
. ./scripts/toolchain.sh
sh scripts/build-info.sh
scriptc build src/main.ts -o agentglass
