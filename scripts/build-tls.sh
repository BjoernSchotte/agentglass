#!/bin/sh
# build agentglass-receive-tls (built-in HTTPS for agentglass receive) with scriptc's C backend and smoke-test it against
# ./agentglass: release CI per target (build-artifacts.yml) and the PR matrix (receive-tls.yml). Exit 1 = not shippable
set -e
cd "$(dirname "$0")/.."
. ./scripts/toolchain.sh
[ -x ./agentglass ] || { echo "build-tls.sh: build ./agentglass first" >&2; exit 1; }
scriptc build --backend c src/receive-tls.ts -o agentglass-receive-tls
[ "$(./agentglass-receive-tls --version)" = "$(./agentglass --version)" ] || { echo "build-tls.sh: version differs from ./agentglass" >&2; exit 1; }
RECEIVE_TLS_REQUIRED=1 AGENTGLASS_BIN=./agentglass AGENTGLASS_TLS_BIN=./agentglass-receive-tls sh scripts/receive-tls.test.sh
