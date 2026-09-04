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
- [ ] **CDP JWT signing** (`src/payments.ts` `cdpAuthHeaders`) — needed for Base
      mainnet settlement; blocked on minting the CDP API key
- [ ] deploy to Cloudflare + self-seed one paid call to trigger Bazaar indexing
- [ ] kill date: 6–8 weeks of zero paid calls → shelve
