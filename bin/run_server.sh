#!/bin/bash
# Launches the x402check Deno server with mainnet CDP facilitator creds pulled
# fresh from `pass` at process start — never written to disk. Meant to run
# under systemd-run --user (see deploy notes in DEPLOY_HANDOFF.md / decisions.md).
set -euo pipefail
cd "$(dirname "$0")/.."

export PAY_TO="0xceEc1c3F6CD66dC7c91fae0e232Eac0d346564e9"
export FACILITATOR_URL="https://api.cdp.coinbase.com/platform/v2/x402"
export CDP_API_KEY_ID
CDP_API_KEY_ID="$(pass show api/cdp/key-id)"
export CDP_API_KEY_SECRET
CDP_API_KEY_SECRET="$(pass show api/cdp/keyfile-json | python3 -c 'import json,sys; print(json.load(sys.stdin)["privateKey"])')"
export PORT="${PORT:-8000}"

exec deno run --allow-net --allow-env deno_entry.ts
