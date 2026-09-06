// Run: node --test test/web.test.ts
//
// Free browser UI: content negotiation on `/`, the rate limiter, and the
// cheap error paths of `/check-free` (no network needed for these).

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPage, wantsHtml, rateLimited } from "../src/web.ts";
import worker from "../src/index.ts";

const ENV = { PAY_TO: "0x000000000000000000000000000000000000dEaD" } as any;

test("wantsHtml: browser Accept vs tool/agent Accept", () => {
  const html = new Request("https://x/", { headers: { accept: "text/html,application/xhtml+xml" } });
  const jsonReq = new Request("https://x/", { headers: { accept: "application/json" } });
  const bare = new Request("https://x/");
  assert.equal(wantsHtml(html), true);
  assert.equal(wantsHtml(jsonReq), false);
  assert.equal(wantsHtml(bare), false);
});

test("renderPage: HTML content-type and the form the script drives", async () => {
  const res = renderPage();
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  const body = await res.text();
  assert.match(body, /<form id="f">/);
  assert.match(body, /\/check-free\?url=/);
});

test("`/` serves HTML to a browser, JSON to a tool", async () => {
  const htmlRes = await worker.fetch(
    new Request("https://x402check.example/", { headers: { accept: "text/html" } }),
    ENV,
  );
  assert.equal(htmlRes.headers.get("content-type"), "text/html; charset=utf-8");

  const jsonRes = await worker.fetch(new Request("https://x402check.example/"), ENV);
  assert.match(jsonRes.headers.get("content-type") ?? "", /application\/json/);
  const desc = (await jsonRes.json()) as Record<string, unknown>;
  assert.equal(desc.service, "x402check");
  assert.ok(desc.free_web_ui);
});

test("`/check-free` without ?url= is a clean 400", async () => {
  const res = await worker.fetch(new Request("https://x402check.example/check-free"), ENV);
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as Record<string, unknown>).error, "missing ?url= parameter");
});

test("`/favicon.svg` and `/favicon.ico` serve an SVG icon", async () => {
  for (const p of ["/favicon.svg", "/favicon.ico"]) {
    const res = await worker.fetch(new Request(`https://x402check.example${p}`), ENV);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.match(await res.text(), /<svg/);
  }
});

test("renderPage: links a favicon", async () => {
  const body = await renderPage().text();
  assert.match(body, /rel="icon"/);
});

test("rateLimited: trips only after the per-minute cap for one IP", () => {
  const ip = `test-${Math.random()}`;
  let tripped = false;
  for (let i = 0; i < 25; i++) tripped = rateLimited(ip) || tripped;
  assert.equal(tripped, true, "should trip within 25 hits (cap is 20)");
  assert.equal(rateLimited(`other-${Math.random()}`), false, "a different IP is unaffected");
});
