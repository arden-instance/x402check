// x402 v2 payment challenge construction + verify/settle via a facilitator.
//
// The facilitator API (Coinbase CDP / x402.org) exposes:
//   POST /verify   { paymentPayload, paymentRequirements } -> { isValid, invalidReason? }
//   POST /settle   { paymentPayload, paymentRequirements } -> { success, transaction, network, payer }
//
// Base mainnet settlement requires CDP auth (JWT from an API key pair). This
// module builds the requests; the CDP JWT signing is done in cdpAuth().

export class PaymentError extends Error {}

export interface Requirements {
  payTo: string;
  price: string; // atomic units, base-10 string
  network: string; // CAIP-2
  asset: string; // token contract
  resourceUrl: string;
}

interface EnvLike {
  FACILITATOR_URL?: string;
  CDP_API_KEY_ID?: string;
  // base64 (standard) encoding of the 64-byte CDP Ed25519 key material
  // (32-byte seed || 32-byte public key), exactly as CDP hands it out in the
  // downloaded key file's `privateKey` field.
  CDP_API_KEY_SECRET?: string;
}

const DEFAULT_FACILITATOR = "https://x402.org/facilitator";

/** The `accepts[]` entry describing how to pay this endpoint. */
function acceptsEntry(r: Requirements) {
  return {
    scheme: "exact",
    network: r.network,
    amount: r.price,
    asset: r.asset,
    payTo: r.payTo,
    maxTimeoutSeconds: 120,
    extra: { name: "USD Coin", version: "2" },
  };
}

export function buildChallenge(r: Requirements): { body: unknown; header: string } {
  const body = {
    x402Version: 2,
    error: "Payment required: this endpoint costs USDC per call",
    resource: {
      url: r.resourceUrl,
      description: "x402 conformance pre-flight check",
      mimeType: "application/json",
    },
    accepts: [acceptsEntry(r)],
  };
  const header = Buffer.from(JSON.stringify(body)).toString("base64");
  return { body, header };
}

function decodePayment(paymentHeader: string): unknown {
  try {
    const raw = Buffer.from(paymentHeader.trim(), "base64").toString("utf8");
    return JSON.parse(raw);
  } catch (e) {
    throw new PaymentError(`X-PAYMENT header is not base64 JSON: ${(e as Error).message}`);
  }
}

export interface SettleResult {
  txHash: string | null;
  payer: string | null;
}

export async function verifyAndSettle(args: {
  paymentHeader: string;
  env: EnvLike;
  requirements: Requirements;
}): Promise<SettleResult> {
  const { paymentHeader, env, requirements } = args;
  const base = (env.FACILITATOR_URL ?? DEFAULT_FACILITATOR).replace(/\/$/, "");
  const decoded = decodePayment(paymentHeader);
  const paymentRequirements = acceptsEntry(requirements);
  // CDP's facilitator schema (x402V2PaymentPayload) additionally requires an
  // `accepted` field on the payload itself, echoing which paymentRequirements
  // entry the client is paying against — not part of the generic x402-spec
  // payload shape the client signed, so we splice it in here rather than
  // asking clients to include it.
  const paymentPayload = { ...(decoded as Record<string, unknown>), accepted: paymentRequirements };

  const verifyUrl = `${base}/verify`;
  const verifyResp = await fetch(verifyUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(await cdpAuthHeaders(env, "POST", verifyUrl)),
    },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
  });
  if (!verifyResp.ok) {
    const bodyText = await verifyResp.text().catch(() => "");
    throw new PaymentError(`facilitator /verify HTTP ${verifyResp.status}: ${bodyText.slice(0, 500)}`);
  }
  const verify = (await verifyResp.json()) as { isValid?: boolean; invalidReason?: string };
  if (!verify.isValid) {
    throw new PaymentError(`payment invalid: ${verify.invalidReason ?? "unknown reason"}`);
  }

  const settleUrl = `${base}/settle`;
  const settleResp = await fetch(settleUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(await cdpAuthHeaders(env, "POST", settleUrl)),
    },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
  });
  if (!settleResp.ok) {
    const bodyText = await settleResp.text().catch(() => "");
    throw new PaymentError(`facilitator /settle HTTP ${settleResp.status}: ${bodyText.slice(0, 500)}`);
  }
  const settle = (await settleResp.json()) as {
    success?: boolean;
    transaction?: string;
    payer?: string;
    errorReason?: string;
  };
  if (!settle.success) {
    throw new PaymentError(`settlement failed: ${settle.errorReason ?? "unknown reason"}`);
  }
  return { txHash: settle.transaction ?? null, payer: settle.payer ?? null };
}

const b64urlFromBytes = (b: ArrayBuffer | Uint8Array): string =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const b64urlFromJson = (o: unknown): string =>
  Buffer.from(JSON.stringify(o)).toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const keyCache = new Map<string, Promise<CryptoKey>>();
function importCdpKey(secretB64: string): Promise<CryptoKey> {
  const raw = Buffer.from(secretB64, "base64");
  if (raw.length !== 64) {
    throw new PaymentError(
      `CDP_API_KEY_SECRET decodes to ${raw.length} bytes, expected 64 (seed||pubkey)`,
    );
  }
  let entry = keyCache.get(secretB64);
  if (!entry) {
    const jwk: JsonWebKey = {
      kty: "OKP",
      crv: "Ed25519",
      d: b64urlFromBytes(raw.subarray(0, 32)),
      x: b64urlFromBytes(raw.subarray(32, 64)),
    };
    entry = crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
    keyCache.set(secretB64, entry);
  }
  return entry;
}

/**
 * Build the Authorization header for a single CDP-authenticated request.
 *
 * CDP Bearer auth is a per-request EdDSA JWT: 2-minute expiry, random nonce,
 * and a `uris` claim bound to exactly this METHOD + host + path, so a fresh
 * token must be minted for every call (verify and settle each get their own).
 *
 * With no CDP creds in env this returns `{}` — fine for the public
 * x402.org facilitator on base-sepolia, NOT enough for Base mainnet settle.
 */
export async function cdpAuthHeaders(
  env: EnvLike,
  method: string,
  url: string,
): Promise<Record<string, string>> {
  if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) return {};

  const u = new URL(url);
  const key = await importCdpKey(env.CDP_API_KEY_SECRET);
  const now = Math.floor(Date.now() / 1000);
  const nonce = b64urlFromBytes(crypto.getRandomValues(new Uint8Array(16)));

  const header = { alg: "EdDSA", typ: "JWT", kid: env.CDP_API_KEY_ID, nonce };
  const claims = {
    sub: env.CDP_API_KEY_ID,
    iss: "cdp",
    aud: ["cdp_service"],
    nbf: now,
    exp: now + 120,
    uris: [`${method.toUpperCase()} ${u.host}${u.pathname}`],
  };

  const signingInput = `${b64urlFromJson(header)}.${b64urlFromJson(claims)}`;
  const sig = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${b64urlFromBytes(sig)}`;

  return { Authorization: `Bearer ${jwt}` };
}
