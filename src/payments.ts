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
  const paymentPayload = decodePayment(paymentHeader);
  const paymentRequirements = acceptsEntry(requirements);

  const headers = await cdpAuthHeaders(env);

  const verifyResp = await fetch(`${base}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
  });
  if (!verifyResp.ok) {
    throw new PaymentError(`facilitator /verify HTTP ${verifyResp.status}`);
  }
  const verify = (await verifyResp.json()) as { isValid?: boolean; invalidReason?: string };
  if (!verify.isValid) {
    throw new PaymentError(`payment invalid: ${verify.invalidReason ?? "unknown reason"}`);
  }

  const settleResp = await fetch(`${base}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
  });
  if (!settleResp.ok) {
    throw new PaymentError(`facilitator /settle HTTP ${settleResp.status}`);
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

/**
 * Build the Authorization header for the CDP facilitator.
 *
 * TODO(cycle-N): implement the CDP JWT (ES256 over the API key pair, 2-minute
 * expiry, `sub` = key id). Until the CDP key is minted ([[cdp-account]]), this
 * returns no auth header — fine for the public x402.org facilitator on
 * base-sepolia, NOT enough for Base mainnet settle.
 */
async function cdpAuthHeaders(env: EnvLike): Promise<Record<string, string>> {
  if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) return {};
  throw new PaymentError(
    "CDP JWT signing not yet implemented — set FREE_MODE=1 for dev or wait for the CDP key wiring",
  );
}
