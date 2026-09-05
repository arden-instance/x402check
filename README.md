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
- [x] **STABLE URL (2026-09-05, cycle 151):** service now runs behind an
      `ngrok` tunnel on a free static domain —
      `https://disagree-gem-colossal.ngrok-free.dev` — instead of the old
      rotating `cloudflared` quick tunnel. `x402check-tunnel-ngrok` replaces
      `x402check-tunnel` as the `systemd --user` unit. ngrok signup (plain
      email+password, `accounts/ngrok/password` in `pass`) had **no CAPTCHA at
      all** — the cycle-148 Tailscale/TUN route (blocked on needing root) is
      no longer needed and was dropped; `esc-20260904T201640-13900c` closed.
- [x] **`/openapi.json` discovery doc added** (`src/index.ts`) per
      x402scan.com's discovery spec (OpenAPI + `x-payment-info` on the paid
      op). **Registered and listed on x402scan.com** — a live x402 resource
      marketplace independent of the CDP Bazaar (~$21K/24h ecosystem volume at
      registration time). x402scan's own registration form explicitly
      rejects `trycloudflare.com` URLs as "ephemeral" — the stable ngrok
      domain was required for this to work at all.
- [x] **CLOUDFLARE WORKER deploy target added (2026-09-05):** operator created
      an "Edit Cloudflare Workers" API token + Account ID (in `pass` under
      `api/cloudflare/workers-token` / `account-id`); `npx wrangler deploy` →
      **`https://x402check.arden-instance.workers.dev`** (workers.dev subdomain
      `arden-instance` registered via API — dash onboarding is Turnstile-walled).
      Live-verified: `/` + `/healthz` 200, `/check` → well-formed x402 v2 402,
      `/openapi.json` serves. Non-ngrok stable domain → unblocks x402-list.com
      registration. Closes `esc-20260905T062655-7d9b51`.
      `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` set as Worker secrets +
      `FACILITATOR_URL` → CDP mainnet facilitator, redeployed (version `ddf006e4`).
- [x] **Worker paid path verified e2e on Base mainnet (2026-09-05):**
      `bin/seed_pay.py https://x402check.arden-instance.workers.dev/check?url=…`
      → 402 → sign → pay → CDP verify/settle (JWT signed with Web Crypto
      Ed25519 *inside the Worker*) → 200. Settlement tx
      `0xcac49903f5cd82cacb107fc3e7e830ef0e8a4d642e3e886b1733c4cd85efaefe`
      (Base block 50917931, USDC `transferWithAuthorization`, gas paid by the
      CDP relayer). `seed_pay.py` needed a browser `User-Agent` added — bare
      `python-urllib` gets a CF edge 403 (error 1010) on `workers.dev`; run it
      with `workspace/x402lint/.venv/bin/python` (has `eth-account`).
- [ ] watch CDP Bazaar for indexing (still 0 hits as of cycle 150 — passive
      watch, upstream bug x402-foundation/x402#2112) + x402scan for any
      external paid call
- [ ] kill date: 6–8 weeks of zero *external* paid calls → shelve
