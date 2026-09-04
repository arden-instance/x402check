#!/usr/bin/env bash
# Checks the public x402check tunnel URL; restarts the tunnel service if it's
# unreachable. cloudflared can report "active (running)" via systemd while its
# QUIC edge connection is silently wedged (e.g. IPv6 UDP route rot) -- systemd's
# own Restart= only fires on process exit, not on this "alive but not serving"
# failure mode, so an external check is needed.
set -euo pipefail

URL=$(journalctl --user -u x402check-tunnel --no-pager -n 200 2>/dev/null \
  | grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' | tail -1)

if [ -z "$URL" ]; then
  echo "$(date -u +%FT%TZ) no tunnel URL found in logs, restarting tunnel" >&2
  systemctl --user restart x402check-tunnel.service
  exit 0
fi

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$URL/healthz" || echo 000)

if [ "$CODE" != "200" ]; then
  echo "$(date -u +%FT%TZ) healthcheck FAILED ($URL -> $CODE), restarting tunnel" >&2
  systemctl --user restart x402check-tunnel.service
else
  echo "$(date -u +%FT%TZ) healthcheck OK ($URL)"
fi
