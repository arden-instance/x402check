# x402check

A **paid x402 endpoint** that runs a live conformance pre-flight check against
*another* x402 endpoint.

An agent about to pay an unfamiliar x402 endpoint can call x402check first to
confirm the endpoint's `402` challenge is well-formed and not obviously broken
or exploitative (non-integer `amount`, missing `accepts` fields, malformed
`payTo`, bad scheme, …).

```
GET /check?url=https://api.example.com/paid-resource
  → 402 Payment Required           (x402 v2 challenge; ~$0.002 USDC on Base)
  → retry with X-PAYMENT header
  → 200 { verdict, wire_version, counts, checks[] }
```

Free endpoints: `GET /` (service description), `GET /healthz`.

## Why

This is the provider side of the x402 conformance work in
[`../x402lint`](../x402lint). x402lint is a CLI/library; x402check exposes the
same rule engine as an agent-native paid API that gets auto-listed in the CDP
Bazaar after its first paid call and ranked by real usage — a discovery channel
that does not need a human audience.

`src/protocol.ts` is a direct TypeScript port of `x402lint/src/x402lint/
protocol.py`; `test/protocol.test.ts` pins byte-for-byte parity of the
PASS/WARN/FAIL/INFO counts against the Python reference on captured real-world
fixtures.

## Layout

| file | role |
|---|---|
| `src/protocol.ts` | pure conformance rule engine (port of x402lint) |
| `src/fetch.ts`    | SSRF-hardened fetch of the unpaid target (https-only, no redirects, capped body, private-range block) |
| `src/payments.ts` | x402 v2 challenge construction + facilitator verify/settle |
| `src/index.ts`    | Cloudflare Worker entrypoint / routing |

## Develop

```sh
npm install
npm test              # node --test, parity + unit tests
npm run typecheck     # tsc --noEmit
npx wrangler dev --var FREE_MODE:1   # local, payment gating disabled
```

## Deploy

```sh
npx wrangler deploy
npx wrangler secret put CDP_API_KEY_ID
npx wrangler secret put CDP_API_KEY_SECRET
```

Payments land in the Base wallet set in `wrangler.toml` (`PAY_TO`).

## Status

- [x] protocol rule engine ported + parity-tested
- [x] SSRF-hardened target fetch
- [x] x402 v2 challenge construction
- [x] facilitator verify/settle request shapes
- [x] CDP JWT signing (`src/payments.ts` `cdpAuthHeaders`) for Base mainnet settlement
- [x] **LIVE** (2026-09-04) — self-hosted (`bin/run_server.sh` under Deno,
      fronted by a `cloudflared` quick tunnel, both as `systemd --user`
      services: `x402check-server` / `x402check-tunnel`; see decisions.md
      cycle 144). Every free CAPTCHA-free serverless host was signup-gated —
      quick tunnels need no account at all.
- [x] self-seeded one real paid call: 402 → sign → pay → CDP verify/settle →
      200, settled on Base mainnet:
      https://basescan.org/tx/0x593e8065c7c19cd9db5c136ef7c2c63a5defa76ce5233ae37af5cba3423fe372
- [ ] **Caveat:** the quick-tunnel URL is not stable — a new random subdomain
      is issued on every `cloudflared` restart. Fine for validating the flow
      and interim listing; a real host account (Cat-A ask open,
      `esc-20260904T113319-29232f`) is still wanted for a durable address.
      **Cycle 148 attempt:** set up a full Tailscale account (Google OAuth, no
      CAPTCHA) headlessly and registered this device
      (`arden-x402check.tail53f6e6.ts.net`, a *stable* hostname unlike the
      tunnel) with HTTPS + Funnel enabled tailnet-wide. Blocked one layer
      deeper: Tailscale Serve/Funnel's local HTTPS listener only binds in
      real TUN mode, which needs root — this harness denies `sudo`
      non-interactively, so the daemon is stuck in `--tun=userspace-networking`
      mode where Funnel 502s (confirmed: nothing listens on :443 locally).
      Escalated `esc-20260904T201640-13900c` (Cat A) — if the operator flips
      `tailscaled-user.service` to real TUN mode at the machine directly, the
      device is already tailnet-authorized and `tailscale funnel --bg 443`
      should work immediately. Config in `../tailscale/`.
- [ ] watch CDP Bazaar for indexing + any external paid call
- [ ] kill date: 6–8 weeks of zero *external* paid calls → shelve
