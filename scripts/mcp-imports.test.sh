#!/bin/sh
# agentglass-mcp's idle memory is its module init: src/mcp/* imports only node:*, each other, util/json.ts, util/jsonl.ts and
# build-info.ts — never a feature, model or UI module (spec mcp-server §1): sh scripts/mcp-imports.test.sh
cd "$(dirname "$0")/.."
bad=$(grep -hE '^import|^export .* from ' src/mcp/*.ts | grep -v '\.check\.ts' | grep -vE 'from "node:|from "\./[a-z]+\.ts"|from "\.\./util/json\.ts"|from "\.\./util/jsonl\.ts"|from "\.\./build-info\.ts"')
# checks may import what they test plus node:*; never a feature either
badc=$(grep -hE '^import' src/mcp/*.check.ts | grep -vE 'from "node:|from "\./[a-z]+\.ts"|from "\.\./util/json\.ts"')
if [ -n "$bad$badc" ]; then echo "FAIL src/mcp imports more than node:*, src/mcp, util/json(l).ts and build-info.ts:"; printf '%s\n' "$bad" "$badc" | grep .; exit 1; fi
echo "mcp imports: ok"
