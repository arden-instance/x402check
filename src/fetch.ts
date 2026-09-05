// Fetch an unpaid x402 endpoint safely and normalise its response for
// protocol.lintResponse(). SSRF-hardened: https only, public hosts only, no
// redirects, hard timeout, capped body read.

const MAX_BODY_BYTES = 64 * 1024;
const TIMEOUT_MS = 8000;

// RFC1918 / loopback / link-local / unique-local / CGNAT, plus obvious metadata
// endpoints. IPv4 literal check is exact; hostnames are resolved by the runtime
// so we also block anything that isn't a plain public-looking name.
const BLOCKED_HOST_RE =
  /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|10\.\d+\.\d+\.\d+|127\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|\[?::1\]?|\[?fc[0-9a-f]{2}:.*|\[?fd[0-9a-f]{2}:.*|\[?fe80:.*|metadata\.google\.internal|169\.254\.169\.254)$/i;

export class UnsafeUrlError extends Error {}

export interface FetchedResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  finalUrl: string;
  method: "GET" | "POST"; // which verb produced this response
}

export function assertSafeUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrlError("not a valid URL");
  }
  if (u.protocol !== "https:") {
    throw new UnsafeUrlError("only https:// URLs are accepted");
  }
  const hostname = u.hostname.replace(/^\[|\]$/g, "");
  if (BLOCKED_HOST_RE.test(u.hostname) || BLOCKED_HOST_RE.test(hostname)) {
    throw new UnsafeUrlError("host is not a public address");
  }
  if (!hostname.includes(".") && hostname !== "localhost") {
    // bare single-label host (could be a container/service name)
    throw new UnsafeUrlError("host must be a fully-qualified public domain");
  }
  return u;
}

export async function fetchUnpaid(raw: string): Promise<FetchedResponse> {
  const u = assertSafeUrl(raw);

  // Probe with GET first — the common case. Many real x402 resources are
  // POST-only (search / inference APIs), where a GET hits no route and returns
  // 404/405; in that case retry once with POST so we still see the 402
  // challenge. A conformant x402 endpoint answers 402 *before* processing the
  // request body, so sending `{}` has no side effect on a paid resource.
  const got = await probe(u, "GET");
  if (got.status === 404 || got.status === 405) {
    const posted = await probe(u, "POST");
    if (posted.status !== 404 && posted.status !== 405) return posted;
  }
  return got;
}

async function probe(u: URL, method: "GET" | "POST"): Promise<FetchedResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const headers: Record<string, string> = {
    accept: "application/json, */*",
    "user-agent": "x402check/0.1 (+conformance probe)",
  };
  if (method === "POST") headers["content-type"] = "application/json";
  let resp: Response;
  try {
    resp = await fetch(u.toString(), {
      method,
      redirect: "manual", // never chase redirects into private space
      signal: ctrl.signal,
      headers,
      body: method === "POST" ? "{}" : undefined,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new UnsafeUrlError(`fetch failed: ${(e as Error).message}`);
  }
  clearTimeout(timer);

  const respHeaders: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    respHeaders[k] = v;
  });

  // Cap body read.
  let bodyText = "";
  if (resp.body) {
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    bodyText = new TextDecoder().decode(concat(chunks).slice(0, MAX_BODY_BYTES));
  }

  return { status: resp.status, headers: respHeaders, bodyText, finalUrl: u.toString(), method };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
