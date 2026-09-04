// Run: node --test test/payments.test.ts
//
// Offline structural checks for the CDP EdDSA JWT builder. The signature is
// verified against the embedded public key (no network, no real CDP key needed);
// a live end-to-end check against api.cdp.coinbase.com is done manually when the
// key in `pass api/cdp/keyfile-json` rotates.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cdpAuthHeaders } from "../src/payments.ts";

// A throwaway Ed25519 keypair generated for this test only.
const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
const seed = Buffer.from(jwk.d!.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const pub = Buffer.from(jwk.x!.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const SECRET_B64 = Buffer.concat([seed, pub]).toString("base64");
const KEY_ID = "11111111-2222-3333-4444-555555555555";

const b64urlToBuf = (s: string) =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

test("no CDP creds -> empty headers (public-facilitator / base-sepolia path)", async () => {
  assert.deepEqual(await cdpAuthHeaders({}, "POST", "https://x402.org/facilitator/verify"), {});
});

test("CDP JWT has the shape and signature CDP expects", async () => {
  const url = "https://api.cdp.coinbase.com/platform/v2/x402/settle";
  const { Authorization } = await cdpAuthHeaders(
    { CDP_API_KEY_ID: KEY_ID, CDP_API_KEY_SECRET: SECRET_B64 },
    "post",
    url,
  );
  assert.ok(Authorization.startsWith("Bearer "));
  const [h, c, s] = Authorization.slice(7).split(".");

  const header = JSON.parse(b64urlToBuf(h).toString());
  assert.equal(header.alg, "EdDSA");
  assert.equal(header.typ, "JWT");
  assert.equal(header.kid, KEY_ID);
  assert.match(header.nonce, /^[A-Za-z0-9_-]+$/);

  const claims = JSON.parse(b64urlToBuf(c).toString());
  assert.equal(claims.sub, KEY_ID);
  assert.equal(claims.iss, "cdp");
  assert.deepEqual(claims.aud, ["cdp_service"]);
  assert.deepEqual(claims.uris, ["POST api.cdp.coinbase.com/platform/v2/x402/settle"]);
  assert.ok(claims.exp - claims.nbf === 120);
  const skew = Math.abs(claims.nbf - Math.floor(Date.now() / 1000));
  assert.ok(skew < 30, `nbf skew ${skew}s`);

  const ok = await crypto.subtle.verify(
    "Ed25519",
    kp.publicKey,
    b64urlToBuf(s),
    new TextEncoder().encode(`${h}.${c}`),
  );
  assert.ok(ok, "signature must verify against the key's public half");
});

test("fresh nonce + signature per call", async () => {
  const env = { CDP_API_KEY_ID: KEY_ID, CDP_API_KEY_SECRET: SECRET_B64 };
  const a = await cdpAuthHeaders(env, "POST", "https://api.cdp.coinbase.com/x/verify");
  const b = await cdpAuthHeaders(env, "POST", "https://api.cdp.coinbase.com/x/verify");
  assert.notEqual(a.Authorization, b.Authorization);
});

test("rejects a secret that is not 64 bytes", async () => {
  await assert.rejects(
    cdpAuthHeaders(
      { CDP_API_KEY_ID: KEY_ID, CDP_API_KEY_SECRET: Buffer.alloc(32).toString("base64") },
      "POST",
      "https://api.cdp.coinbase.com/x/verify",
    ),
    /64/,
  );
});
