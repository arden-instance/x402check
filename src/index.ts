// x402check — a paid x402 endpoint that runs a live conformance pre-flight
// check against another x402 endpoint.
//
//   GET /check?url=<https endpoint>
//     → 402 Payment Required  (x402 v2 challenge, pay ~$0.002 USDC on Base)
//     → client retries with an X-PAYMENT header
//     → we verify (+ settle) the payment, then fetch <url>, lint it, and return
//        { verdict: PASS|WARN|FAIL, wire_version, counts, checks[] }
//
//   GET /            → service description (free)
//   GET /healthz     → { ok: true } (free)
//
// Deploy target: Cloudflare Workers (free tier). Payments land in the Base
// wallet configured via PAY_TO. Settlement uses an x402 facilitator
// (FACILITATOR_URL, + CDP_API_KEY_ID / CDP_API_KEY_SECRET for Base mainnet).

import { lintResponse } from "./protocol.ts";
import { fetchUnpaid, UnsafeUrlError } from "./fetch.ts";
import { buildChallenge, verifyAndSettle, PaymentError } from "./payments.ts";

export interface Env {
  PAY_TO: string; // 0x… Base address that receives payment
  PRICE_ATOMIC?: string; // USDC atomic units (6dp); default "2000" = $0.002
  NETWORK?: string; // CAIP-2; default "eip155:8453" (Base mainnet)
  ASSET?: string; // token contract; default Base USDC
  FACILITATOR_URL?: string; // x402 facilitator base URL
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  FREE_MODE?: string; // "1" → skip payment (local dev only)
}

const DESCRIPTION = {
  service: "x402check",
  summary:
    "Live x402 conformance pre-flight. Pass ?url=<https x402 endpoint> and pay " +
    "to get a structured PASS/WARN/FAIL verdict on its 402 challenge before you " +
    "trust it with a real payment.",
  usage: "GET /check?url=https://api.example.com/paid-resource",
  price: "~$0.002 USDC on Base per check",
  source: "https://github.com/arden-instance/x402check",
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method !== "GET") {
      return json({ error: "method not allowed" }, { status: 405 });
    }
    if (url.pathname === "/" || url.pathname === "") {
      return json(DESCRIPTION);
    }
    if (url.pathname === "/healthz") {
      return json({ ok: true });
    }
    if (url.pathname !== "/check") {
      return json({ error: "not found" }, { status: 404 });
    }

    const target = url.searchParams.get("url");
    if (!target) {
      return json({ error: "missing ?url= parameter" }, { status: 400 });
    }

    const price = env.PRICE_ATOMIC ?? "2000";
    const network = env.NETWORK ?? "eip155:8453";
    const asset = env.ASSET ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    // Behind a reverse proxy (cloudflared quick tunnel, CF Workers edge) the
    // request the runtime sees is plain HTTP even though the public URL is
    // HTTPS-only — advertise the externally-reachable scheme, not the one the
    // local process observes, so `resource` in the 402 challenge (and hence
    // the Bazaar listing) actually resolves.
    const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const forwardedHost = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    const scheme = forwardedProto || (url.protocol === "http:" ? "https" : url.protocol.replace(":", ""));
    const host = forwardedHost || url.host;
    const resourceUrl = `${scheme}://${host}${url.pathname}${url.search}`;

    const freeMode = env.FREE_MODE === "1";
    const paymentHeader = req.headers.get("x-payment");

    if (!freeMode && !paymentHeader) {
      const challenge = buildChallenge({ payTo: env.PAY_TO, price, network, asset, resourceUrl });
      return new Response(JSON.stringify(challenge.body), {
        status: 402,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "payment-required": challenge.header,
        },
      });
    }

    let settlement: Awaited<ReturnType<typeof verifyAndSettle>> | null = null;
    if (!freeMode) {
      try {
        settlement = await verifyAndSettle({
          paymentHeader: paymentHeader!,
          env,
          requirements: { payTo: env.PAY_TO, price, network, asset, resourceUrl },
        });
      } catch (e) {
        if (e instanceof PaymentError) {
          return json({ error: "payment verification failed", detail: e.message }, { status: 402 });
        }
        throw e;
      }
    }

    // Payment good (or free mode) — run the actual check.
    let fetched;
    try {
      fetched = await fetchUnpaid(target);
    } catch (e) {
      if (e instanceof UnsafeUrlError) {
        return json({ error: "target URL rejected", detail: e.message }, { status: 400 });
      }
      throw e;
    }

    const report = lintResponse(fetched.finalUrl, fetched.status, fetched.headers, fetched.bodyText);
    const out = json({
      ...report.toJSON(),
      checked_at: new Date().toISOString(),
    });
    if (settlement?.txHash) out.headers.set("x-payment-response", settlement.txHash);
    return out;
  },
};
