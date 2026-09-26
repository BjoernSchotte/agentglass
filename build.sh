#!/bin/sh
# build the native binary (scriptc needs Node 24+ to build, not to run)
set -e
cd "$(dirname "$0")"
PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" scriptc build src/main.ts -o agentglass
