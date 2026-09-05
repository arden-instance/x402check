// Run: node --test test/fetch.test.ts   (Node >= 22, native TS type-stripping)
//
// fetchUnpaid's GET-then-POST fallback: many real x402 resources are POST-only
// (search / inference APIs) where a GET hits no route. We must still surface the
// 402 challenge by retrying once with POST.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchUnpaid } from "../src/fetch.ts";

const realFetch = globalThis.fetch;

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  globalThis.fetch = ((input: string | URL | Request, init: RequestInit = {}) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch;
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test("GET that works is used as-is, no POST retry", async () => {
  const calls: string[] = [];
  stubFetch((_url, init) => {
    calls.push(init.method as string);
    return new Response(JSON.stringify({ x402Version: 1 }), { status: 402 });
  });
  const r = await fetchUnpaid("https://api.example.com/paid");
  assert.equal(r.status, 402);
  assert.equal(r.method, "GET");
  assert.deepEqual(calls, ["GET"]);
});

test("GET 404 falls back to POST and returns the POST result", async () => {
  const calls: string[] = [];
  stubFetch((_url, init) => {
    calls.push(init.method as string);
    if (init.method === "GET") return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ x402Version: 1 }), { status: 402 });
  });
  const r = await fetchUnpaid("https://api.example.com/search");
  assert.equal(r.status, 402);
  assert.equal(r.method, "POST");
  assert.deepEqual(calls, ["GET", "POST"]);
});

test("GET 405 falls back to POST", async () => {
  stubFetch((_url, init) =>
    init.method === "GET"
      ? new Response("", { status: 405 })
      : new Response(JSON.stringify({ x402Version: 1 }), { status: 402 }));
  const r = await fetchUnpaid("https://api.example.com/infer");
  assert.equal(r.method, "POST");
  assert.equal(r.status, 402);
});

test("POST also 404 → keep the original GET result", async () => {
  stubFetch(() => new Response("nope", { status: 404 }));
  const r = await fetchUnpaid("https://api.example.com/missing");
  assert.equal(r.status, 404);
  assert.equal(r.method, "GET");
});

test("POST body is empty JSON object with a json content-type", async () => {
  let seen: RequestInit | null = null;
  stubFetch((_url, init) => {
    if (init.method === "POST") seen = init;
    return init.method === "GET"
      ? new Response("", { status: 404 })
      : new Response("{}", { status: 402 });
  });
  await fetchUnpaid("https://api.example.com/x");
  assert.ok(seen);
  assert.equal((seen as RequestInit).body, "{}");
  assert.equal(
    (((seen as RequestInit).headers as Record<string, string>))["content-type"],
    "application/json",
  );
});
