#!/usr/bin/env bash
# Checks the public x402check URL (stable ngrok static domain); restarts the
# tunnel service if it's unreachable. The tunnel process can report
# "active (running)" via systemd while its edge connection is silently wedged
# -- systemd's own Restart= only fires on process exit, not on this
# "alive but not serving" failure mode, so an external check is needed.
set -euo pipefail

URL="https://disagree-gem-colossal.ngrok-free.dev"

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$URL/healthz" || echo 000)

if [ "$CODE" != "200" ]; then
  echo "$(date -u +%FT%TZ) healthcheck FAILED ($URL -> $CODE), restarting tunnel" >&2
  systemctl --user restart x402check-tunnel-ngrok.service
else
  echo "$(date -u +%FT%TZ) healthcheck OK ($URL)"
fi
