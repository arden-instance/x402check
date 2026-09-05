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
import { renderPage, wantsHtml, rateLimited } from "./web.ts";

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
  free_web_ui: "Open this URL in a browser for a free, rate-limited checker.",
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
      // Browsers get the free interactive checker; tools/agents get the JSON
      // service descriptor.
      return wantsHtml(req) ? renderPage() : json(DESCRIPTION);
    }
    if (url.pathname === "/healthz") {
      return json({ ok: true });
    }
    if (url.pathname === "/check-free") {
      // Free, rate-limited conformance check — powers the browser UI. Same
      // lint logic as the paid /check, minus the payment (and minus the
      // settlement receipt). SSRF protection is in fetchUnpaid, unchanged.
      const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
      if (rateLimited(ip)) {
        return json(
          { error: "rate limited", detail: "Free checks are capped per minute. Use the paid GET /check for programmatic access." },
          { status: 429 },
        );
      }
      const target = url.searchParams.get("url");
      if (!target) return json({ error: "missing ?url= parameter" }, { status: 400 });
      let fetched;
      try {
        fetched = await fetchUnpaid(target);
      } catch (e) {
        if (e instanceof UnsafeUrlError) {
          return json({ error: "target URL rejected", detail: e.message }, { status: 400 });
        }
        throw e;
      }
      const report = lintResponse(fetched.finalUrl, fetched.status, fetched.headers, fetched.bodyText, fetched.method);
      return json({ ...report.toJSON(), checked_at: new Date().toISOString(), tier: "free" });
    }
    if (url.pathname === "/openapi.json") {
      const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
      const forwardedHost = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
      const scheme = forwardedProto || (url.protocol === "http:" ? "https" : url.protocol.replace(":", ""));
      const host = forwardedHost || url.host;
      const price = env.PRICE_ATOMIC ?? "2000";
      const priceUsd = (Number(price) / 1_000_000).toFixed(6);
      return json({
        openapi: "3.1.0",
        info: {
          title: "x402check",
          version: "1.0.0",
          description: DESCRIPTION.summary,
          "x-guidance":
            "Call GET /check?url=<https x402 endpoint you're about to pay> to get a " +
            "structured PASS/WARN/FAIL conformance verdict on its 402 challenge before " +
            "trusting it with a real payment. Pay ~$0.002 USDC on Base per check. " +
            "Humans can use the free rate-limited browser UI at / instead.",
          contact: { email: "arden.instance@gmail.com" },
        },
        paths: {
          "/check": {
            get: {
              operationId: "checkX402Endpoint",
              summary: "Conformance pre-flight check on another x402 endpoint",
              tags: ["Check"],
              "x-payment-info": {
                price: { mode: "fixed", currency: "USD", amount: priceUsd },
                protocols: [{ x402: {} }],
              },
              parameters: [
                {
                  name: "url",
                  in: "query",
                  required: true,
                  schema: { type: "string" },
                  description: "The x402 endpoint to check (must be https)",
                },
              ],
              responses: {
                "200": {
                  description: "Conformance verdict",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          verdict: { type: "string", enum: ["PASS", "WARN", "FAIL"] },
                        },
                        required: ["verdict"],
                      },
                    },
                  },
                },
                "402": { description: "Payment Required" },
              },
            },
          },
          "/check-free": {
            get: {
              operationId: "checkX402EndpointFree",
              summary: "Free rate-limited conformance check (powers the browser UI; no payment, no settlement receipt)",
              tags: ["Check"],
              parameters: [
                {
                  name: "url",
                  in: "query",
                  required: true,
                  schema: { type: "string" },
                  description: "The x402 endpoint to check (must be https)",
                },
              ],
              responses: {
                "200": { description: "Conformance verdict" },
                "429": { description: "Rate limited — use the paid /check for programmatic access" },
              },
            },
          },
        },
      });
    }
    if (url.pathname !== "/check") {
      return json({ error: "not found" }, { status: 404 });
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
    // Deliberately drop the query string: `?url=` varies on every call, and
    // baking it into `resource` makes every call advertise a distinct
    // resource identity. CDP's Bazaar indexes/aggregates by exact `resource`
    // string, so a per-call-unique resource never accumulates quality/calls
    // under one listing (verified empirically cycle 146 — every indexed
    // competitor advertises a fixed path; the query contract belongs in
    // outputSchema.input.queryParams, not in the resource URL itself).
    const resourceUrl = `${scheme}://${host}${url.pathname}`;

    const freeMode = env.FREE_MODE === "1";
    // Accept both the classic `X-PAYMENT` header and the newer x402 spec's
    // `PAYMENT-SIGNATURE` name so any conformant client can pay.
    const paymentHeader =
      req.headers.get("x-payment") ?? req.headers.get("payment-signature");

    // Return the 402 challenge whenever payment is absent — even with no `?url=`
    // — so a directory's free 402-handshake probe (x402-list, x402scan, the CDP
    // Bazaar) sees a valid challenge on the bare `/check` path. The `?url=`
    // parameter is only required once payment has been made.
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

    const target = url.searchParams.get("url");
    if (!target) {
      return json({ error: "missing ?url= parameter" }, { status: 400 });
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

    const report = lintResponse(fetched.finalUrl, fetched.status, fetched.headers, fetched.bodyText, fetched.method);
    const out = json({
      ...report.toJSON(),
      checked_at: new Date().toISOString(),
    });
    if (settlement?.txHash) out.headers.set("x-payment-response", settlement.txHash);
    return out;
  },
};
