// x402 wire-format parsing and conformance rules — TypeScript port of
// x402lint/src/x402lint/protocol.py (Python reference implementation).
//
// Pure module: takes an already-fetched response (status, headers, body bytes)
// and returns a Report. Network I/O lives in the Worker entrypoint (index.ts).
//
// Two wire formats exist in the wild:
//  * v2 (x402Version: 2) — dominant 2026. The PaymentRequired document travels
//    base64-encoded in the `payment-required` response header. Networks are
//    CAIP-2 ids (eip155:8453). Amount field is `amount`.
//  * v1 (x402Version: 1) — legacy. The document is the JSON body of the 402.
//    Networks are friendly names (`base`). Amount field is `maxAmountRequired`
//    and each accepts[] entry carries its own `resource` URL.

export const PASS = "PASS";
export const WARN = "WARN";
export const FAIL = "FAIL";
export const INFO = "INFO";

export type Level = "PASS" | "WARN" | "FAIL" | "INFO";

// Scheme / network vocabularies. Unknown values warn rather than fail — the
// protocol is deliberately open and new schemes/chains appear regularly.
const KNOWN_SCHEMES = new Set(["exact", "upto", "batch-settlement"]);
const KNOWN_V1_NETWORKS = new Set([
  "base", "base-sepolia", "avalanche", "avalanche-fuji", "iotex",
  "solana", "solana-devnet", "polygon", "polygon-amoy", "sei", "sei-testnet",
]);

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const UINT = /^(0|[1-9][0-9]*)$/;

export interface Check {
  id: string;
  level: Level;
  message: string;
}

export class Report {
  url: string;
  wireVersion: string | null = null; // "1", "2", or null if undetected
  checks: Check[] = [];

  constructor(url: string) {
    this.url = url;
  }

  add(id: string, level: Level, message: string): void {
    this.checks.push({ id, level, message });
  }

  get failed(): boolean {
    return this.checks.some((c) => c.level === FAIL);
  }

  get counts(): Record<Level, number> {
    const out: Record<Level, number> = { PASS: 0, WARN: 0, FAIL: 0, INFO: 0 };
    for (const c of this.checks) out[c.level] = (out[c.level] ?? 0) + 1;
    return out;
  }

  get verdict(): "PASS" | "WARN" | "FAIL" {
    if (this.failed) return "FAIL";
    if (this.checks.some((c) => c.level === WARN)) return "WARN";
    return "PASS";
  }

  toJSON(): Record<string, unknown> {
    return {
      url: this.url,
      wire_version: this.wireVersion,
      ok: !this.failed,
      verdict: this.verdict,
      counts: this.counts,
      checks: this.checks,
    };
  }
}

export class X402LintError extends Error {}

// --- base64 JSON -----------------------------------------------------------

/** Decode a base64 (std or url-safe, padded or not) JSON blob. */
export function b64json(blob: string): unknown {
  const s = blob.trim();
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  let lastErr: unknown = null;
  for (const normalize of [
    (x: string) => x,
    (x: string) => x.replace(/-/g, "+").replace(/_/g, "/"),
  ]) {
    let raw: string;
    try {
      raw = Buffer.from(normalize(s) + pad, "base64").toString("utf8");
    } catch (e) {
      lastErr = e;
      continue;
    }
    // Buffer.from with "base64" is lenient; guard against silent truncation by
    // requiring the decoded text to parse as JSON.
    try {
      return JSON.parse(raw);
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr instanceof SyntaxError) {
    throw new X402LintError(
      `blob decoded from base64 but is not JSON: ${lastErr.message}`,
    );
  }
  throw new X402LintError("input is not valid base64");
}

// --- helpers -------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function headersLower(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function isAbsUrl(s: unknown): s is string {
  return typeof s === "string" && (s.startsWith("http://") || s.startsWith("https://"));
}

function host(s: unknown): string {
  if (!isAbsUrl(s)) return "";
  const rest = s.split("://", 2)[1];
  return rest.split("/", 1)[0].split("?", 1)[0].toLowerCase();
}

function networkFamily(net: unknown): string | null {
  if (typeof net !== "string") return null;
  if (net.includes(":")) return net.split(":", 1)[0];
  if (
    net.startsWith("base") ||
    ["avalanche", "avalanche-fuji", "polygon", "polygon-amoy", "iotex", "sei", "sei-testnet"].includes(net)
  ) {
    return "eip155";
  }
  if (net.startsWith("solana")) return "solana";
  return null;
}

// --- wire-version detection & document load ------------------------------

export function detectWireVersion(
  status: number,
  headers: Record<string, string>,
  body: unknown,
): string | null {
  const h = headersLower(headers);
  if ("payment-required" in h) return "2";
  if (isObj(body)) {
    const v = body["x402Version"];
    if (v === 1 || (v === undefined && Array.isArray(body["accepts"]))) return "1";
    if (v === 2) return "2";
  }
  return null;
}

function loadDocument(
  status: number,
  headers: Record<string, string>,
  bodyText: string,
  report: Report,
): unknown | null {
  const h = headersLower(headers);
  let body: unknown = null;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = null;
    }
  }

  const version = detectWireVersion(status, headers, body);
  report.wireVersion = version;

  if (version === "2") {
    report.add("format", INFO, "x402 v2 (payment-required header)");
    const blob = h["payment-required"] ?? "";
    let doc: unknown;
    try {
      doc = b64json(blob);
    } catch (e) {
      report.add("header-decode", FAIL, `payment-required header: ${(e as Error).message}`);
      return null;
    }
    report.add("header-decode", PASS, "payment-required header is base64 JSON");
    return doc;
  }
  if (version === "1") {
    report.add("format", INFO, "x402 v1 (JSON body)");
    if (!isObj(body)) {
      report.add("body-parse", FAIL, "402 body is not a JSON object");
      return null;
    }
    report.add("body-parse", PASS, "402 body parses as JSON");
    return body;
  }

  report.add(
    "format",
    FAIL,
    "no x402 payment challenge detected " +
      "(no payment-required header, no x402Version in body)",
  );
  return null;
}

// --- accepts[] entry checks --------------------------------------------

function checkAcceptsEntry(
  i: number,
  entry: unknown,
  version: string,
  checkedHost: string,
  report: Report,
): void {
  const tag = `accepts[${i}]`;
  if (!isObj(entry)) {
    report.add(tag, FAIL, "entry is not an object");
    return;
  }

  const amountKey = version === "2" ? "amount" : "maxAmountRequired";
  const required = ["scheme", "network", amountKey, "asset", "payTo", "maxTimeoutSeconds"];
  const missing = required.filter((k) => !(k in entry));
  if (missing.length) {
    report.add(`${tag}.required`, FAIL, `missing fields: ${missing.join(", ")}`);
  } else {
    report.add(`${tag}.required`, PASS, "all required fields present");
  }

  const scheme = entry["scheme"];
  if (typeof scheme === "string" && KNOWN_SCHEMES.has(scheme)) {
    report.add(`${tag}.scheme`, PASS, JSON.stringify(scheme));
  } else if (typeof scheme === "string" && scheme) {
    report.add(`${tag}.scheme`, WARN, `unrecognised scheme ${JSON.stringify(scheme)}`);
  } else {
    report.add(`${tag}.scheme`, FAIL, "scheme missing or not a string");
  }

  const net = entry["network"];
  if (version === "2") {
    if (typeof net === "string" && CAIP2.test(net)) {
      report.add(`${tag}.network`, PASS, `${net} (CAIP-2)`);
    } else {
      report.add(
        `${tag}.network`,
        WARN,
        `network ${JSON.stringify(net)} is not CAIP-2 shaped (expected e.g. 'eip155:8453')`,
      );
    }
  } else {
    if (typeof net === "string" && KNOWN_V1_NETWORKS.has(net)) {
      report.add(`${tag}.network`, PASS, `${net}`);
    } else if (typeof net === "string" && net) {
      report.add(`${tag}.network`, WARN, `unrecognised v1 network ${JSON.stringify(net)}`);
    } else {
      report.add(`${tag}.network`, FAIL, "network missing or not a string");
    }
  }

  const amt = entry[amountKey];
  if (typeof amt === "string" && UINT.test(amt) && amt !== "0") {
    report.add(`${tag}.${amountKey}`, PASS, `${amt} atomic units`);
  } else {
    report.add(
      `${tag}.${amountKey}`,
      FAIL,
      `${JSON.stringify(amountKey)} must be a base-10 string of a positive integer, got ${JSON.stringify(amt)}`,
    );
  }

  const fam = networkFamily(net);
  for (const addrKey of ["asset", "payTo"]) {
    const val = entry[addrKey];
    if (fam === "eip155") {
      if (typeof val === "string" && EVM_ADDR.test(val)) {
        report.add(`${tag}.${addrKey}`, PASS, "valid EVM address");
      } else {
        report.add(
          `${tag}.${addrKey}`,
          FAIL,
          `${JSON.stringify(addrKey)} is not a 0x + 40 hex EVM address: ${JSON.stringify(val)}`,
        );
      }
    } else {
      if (typeof val === "string" && val) {
        report.add(
          `${tag}.${addrKey}`,
          INFO,
          `${val} (address format not checked for ${fam ?? "unknown"} networks)`,
        );
      } else {
        report.add(`${tag}.${addrKey}`, FAIL, `${JSON.stringify(addrKey)} missing or empty`);
      }
    }
  }

  const to = entry["maxTimeoutSeconds"];
  if (typeof to === "number" && Number.isFinite(to) && to > 0) {
    report.add(`${tag}.maxTimeoutSeconds`, PASS, `${to}`);
  } else {
    report.add(`${tag}.maxTimeoutSeconds`, FAIL, `must be a positive number, got ${JSON.stringify(to)}`);
  }

  if (scheme === "exact" && fam === "eip155") {
    const extra = entry["extra"];
    if (isObj(extra) && extra["name"] && extra["version"]) {
      report.add(
        `${tag}.extra`,
        PASS,
        `EIP-712 domain: name=${JSON.stringify(extra["name"])} version=${JSON.stringify(extra["version"])}`,
      );
    } else {
      report.add(
        `${tag}.extra`,
        WARN,
        "exact/EVM needs extra.name + extra.version for the EIP-712 signature",
      );
    }
  }

  const res = entry["resource"];
  if (version === "1") {
    if (isAbsUrl(res)) {
      const rHost = host(res);
      if (checkedHost && rHost && rHost !== checkedHost) {
        report.add(`${tag}.resource`, WARN, `resource host ${JSON.stringify(rHost)} != checked host ${JSON.stringify(checkedHost)}`);
      } else {
        report.add(`${tag}.resource`, PASS, res);
      }
    } else {
      report.add(`${tag}.resource`, FAIL, `v1 entry must carry an absolute resource URL, got ${JSON.stringify(res)}`);
    }
  }
}

// --- top-level entrypoint --------------------------------------------

/** Run all conformance checks against one fetched (unpaid) response. */
export function lintResponse(
  url: string,
  status: number,
  headers: Record<string, string>,
  bodyText: string,
  method: "GET" | "POST" = "GET",
): Report {
  const report = new Report(url);

  if (method === "POST") {
    report.add("method", INFO, "GET returned 404/405; checked with POST instead");
  }

  if (status === 402) {
    report.add("status", PASS, "HTTP 402 Payment Required");
  } else {
    report.add("status", FAIL, `expected HTTP 402, got ${status}`);
  }

  const doc = loadDocument(status, headers, bodyText, report);
  if (doc === null) return report;
  if (!isObj(doc)) {
    report.add("document", FAIL, "payment challenge is not a JSON object");
    return report;
  }

  const version = report.wireVersion ?? "2";

  const v = doc["x402Version"];
  if (typeof v === "number" && Number.isInteger(v)) {
    report.add("x402Version", PASS, String(v));
  } else {
    report.add("x402Version", FAIL, `missing or non-integer: ${JSON.stringify(v)}`);
  }

  const err = doc["error"];
  if (typeof err === "string" && err.trim()) {
    report.add("error", PASS, JSON.stringify(err));
  } else {
    report.add("error", WARN, "no human-readable 'error' string");
  }

  if (version === "2") {
    const res = doc["resource"];
    if (isObj(res) && isAbsUrl(res["url"])) {
      report.add("resource.url", PASS, res["url"] as string);
    } else {
      report.add("resource.url", WARN, "v2 should carry a top-level resource.url (absolute)");
    }
  }

  const accepts = doc["accepts"];
  if (!Array.isArray(accepts) || accepts.length === 0) {
    report.add("accepts", FAIL, "'accepts' must be a non-empty array");
    return report;
  }
  report.add("accepts", PASS, `${accepts.length} payment option(s)`);

  const checkedHost = host(url);
  accepts.forEach((entry, i) => checkAcceptsEntry(i, entry, version, checkedHost, report));

  const ext = doc["extensions"];
  if (isObj(ext) && "bazaar" in ext) {
    report.add("discovery", INFO, "advertises the 'bazaar' discovery extension");
  } else if (
    version === "1" &&
    accepts.some((e) => isObj(e) && e["outputSchema"])
  ) {
    report.add("discovery", INFO, "carries v1 'outputSchema' discovery hint");
  } else {
    report.add("discovery", INFO, "no discovery metadata (bazaar / outputSchema) — not required");
  }

  return report;
}
