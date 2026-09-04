# x402check — deploy handoff

**Status (2026-09-04, cycle 143):** build is complete and deploy-ready.
`npm test` 12/12 · `tsc --noEmit` clean · `wrangler deploy --dry-run` builds a
41 KiB bundle. The *only* blocker is creating a serverless-host account: every
ToS-compatible free host gates signup behind an anti-abuse control (Turnstile /
hCaptcha / reCAPTCHA) that Arden will not script-click.

Hosts probed cycle 143:
| host | signup gate | commercial use on free tier |
|---|---|---|
| Cloudflare dashboard | Turnstile checkbox | **allowed** |
| Deno Deploy (console.deno.com) | Turnstile checkbox | allowed |
| Val.town | Turnstile | allowed (paid plans for scale) |
| Netlify | reCAPTCHA | allowed |
| Render | hCaptcha | allowed |
| Vercel | **none** (GitHub OAuth worked, account auto-created) | **Hobby = non-commercial only → ruled out** |

## What the operator needs to do (pick ONE)

### Option A — Cloudflare (preferred; wrangler config already written)
1. Sign up at https://dash.cloudflare.com/sign-up (email + Turnstile checkbox).
   Any email is fine; `arden.instance@gmail.com` keeps it with the Arden identity.
2. Create an API token: dashboard → My Profile → API Tokens → Create Token →
   template **"Edit Cloudflare Workers"**. Scope it to the one account. Copy the token.
3. Hand the token to Arden by storing it: `pass insert -f api/cloudflare/workers-token`
   (paste the token). Also note the Account ID (dashboard URL / Workers page).
   `pass insert -f api/cloudflare/account-id`
4. Tell Arden in operator chat that it's done.

Arden then runs, fully headless:
```sh
cd workspace/x402check
export CLOUDFLARE_API_TOKEN=$(pass show api/cloudflare/workers-token)
export CLOUDFLARE_ACCOUNT_ID=$(pass show api/cloudflare/account-id)
npx wrangler deploy
echo "$(pass show api/cdp/key-id)" | npx wrangler secret put CDP_API_KEY_ID
python3 -c "import json;print(json.load(open('/dev/stdin'))['privateKey'])" \
   < <(pass show api/cdp/keyfile-json) | npx wrangler secret put CDP_API_KEY_SECRET
```
(then flip `FACILITATOR_URL` in wrangler.toml to the CDP mainnet facilitator and
redeploy — see wrangler.toml comments.)

### Option B — Deno Deploy
Sign in at https://console.deno.com/login (GitHub OAuth + Turnstile checkbox).
Then Settings → generate an access token → `pass insert -f api/deno-deploy/token`.
Arden adapts via the existing `deno_entry.ts` and runs `deployctl deploy`.

## After deploy (Arden, headless)
1. base-sepolia e2e: point a test client at `/check?url=<known x402 endpoint>`,
   walk the 402 → pay → verify → settle → lint loop on testnet.
2. Mainnet: one self-funded ~$0.002 USDC paid call from the agent wallet to
   trigger CDP Bazaar indexing.
3. Watch Bazaar ranking + paid-call count. Kill date: 6–8 weeks of zero external
   paid calls → shelve.
