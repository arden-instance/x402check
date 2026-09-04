// Run: node --test test/protocol.test.ts   (Node >= 22, native TS type-stripping)
//
// Parity check: the TS port must produce the same PASS/WARN/FAIL/INFO counts as
// the Python reference (x402lint) on the captured real-world fixtures.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { lintResponse, b64json, X402LintError } from "../src/protocol.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");

// Expected counts, generated from the Python reference implementation
// (x402lint.protocol.lint_response) on 2026-09-04.
const EXPECTED: Record<string, { PASS: number; WARN: number; FAIL: number; INFO: number }> = {
  "onesource_v2_multi_scheme.json": { PASS: 21, WARN: 0, FAIL: 0, INFO: 2 },
  "ottoai_v2_signed_offers.json": { PASS: 27, WARN: 0, FAIL: 0, INFO: 4 },
  "riddle_v2_header_only.json": { PASS: 14, WARN: 0, FAIL: 0, INFO: 2 },
  "weather_v2_header_and_body.json": { PASS: 14, WARN: 0, FAIL: 0, INFO: 2 },
};

for (const name of readdirSync(fixturesDir).filter((f) => f.endsWith(".json"))) {
  test(`parity: ${name}`, () => {
    const d = JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
    let body = d.body ?? "";
    if (typeof body !== "string") body = JSON.stringify(body);
    const report = lintResponse(d.url, d.status, d.headers ?? {}, body);
    const expected = EXPECTED[name];
    assert.ok(expected, `no expected counts recorded for ${name}`);
    assert.deepEqual(report.counts, expected, JSON.stringify(report.checks, null, 2));
  });
}

test("b64json decodes url-safe unpadded", () => {
  const obj = { x402Version: 2, accepts: [] };
  const b64 = Buffer.from(JSON.stringify(obj)).toString("base64url");
  assert.deepEqual(b64json(b64), obj);
});

test("b64json rejects non-base64", () => {
  assert.throws(() => b64json("!!!not base64!!!"), X402LintError);
});

test("missing 402 challenge fails cleanly", () => {
  const r = lintResponse("https://example.com/x", 200, {}, "");
  assert.equal(r.failed, true);
  assert.equal(r.verdict, "FAIL");
});

test("non-integer amount is a FAIL", () => {
  const doc = {
    x402Version: 2,
    error: "pay up",
    resource: { url: "https://example.com/x" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: 0.01, // number, not a base-10 string → must FAIL
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0xceEc1c3F6CD66dC7c91fae0e232Eac0d346564e9",
        maxTimeoutSeconds: 60,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
  };
  const header = Buffer.from(JSON.stringify(doc)).toString("base64");
  const r = lintResponse("https://example.com/x", 402, { "payment-required": header }, "");
  assert.equal(r.failed, true);
  assert.ok(r.checks.some((c) => c.id === "accepts[0].amount" && c.level === "FAIL"));
});
