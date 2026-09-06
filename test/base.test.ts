// Run: node --test test/base.test.ts   (Node >= 22, native TS type-stripping)
//
// handleBase: routing, input validation, and JSON-RPC response shaping for the
// paid /base/* Base-chain data API. fetch is stubbed — no live node needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBase, BaseQueryError, decodeAbiString } from "../src/base.ts";

const realFetch = globalThis.fetch;
const env = { BASE_RPC_URL: "https://rpc.test" };

/** Stub fetch with a map of RPC method -> result (or a function). */
function stubRpc(results: Record<string, unknown | ((params: unknown[]) => unknown)>) {
  globalThis.fetch = ((_input: string | URL | Request, init: RequestInit = {}) => {
    const { method, params } = JSON.parse(String(init.body));
    if (!(method in results)) throw new Error(`unexpected RPC method ${method}`);
    const r = results[method];
    const result = typeof r === "function" ? (r as (p: unknown[]) => unknown)(params) : r;
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result })));
  }) as typeof fetch;
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

const q = (s: string) => new URLSearchParams(s);

test("/base/block latest shapes the header fields", async () => {
  stubRpc({
    eth_getBlockByNumber: {
      number: "0x1e240",
      hash: "0xabc",
      parentHash: "0xdef",
      timestamp: "0x66000000",
      miner: "0x0000000000000000000000000000000000004200",
      gasUsed: "0x5208",
      gasLimit: "0x1c9c380",
      baseFeePerGas: "0x3b9aca00",
      transactions: ["0x1", "0x2", "0x3"],
    },
  });
  const res = await handleBase("/base/block", q("number=latest"), env);
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.number, 123456);
  assert.equal(body.transaction_count, 3);
  assert.equal(body.baseFeePerGas_wei, "1000000000");
  assert.equal(body.timestamp_iso.endsWith("Z"), true);
});

test("/base/block rejects a bad number tag", async () => {
  await assert.rejects(() => handleBase("/base/block", q("number=not-a-block"), env), BaseQueryError);
});

test("/base/block accepts a decimal number and converts to hex", async () => {
  let seen: unknown;
  stubRpc({ eth_getBlockByNumber: (p: unknown[]) => ((seen = p), { number: "0x10", timestamp: "0x1", transactions: [] }) });
  await handleBase("/base/block", q("number=16"), env);
  assert.deepEqual(seen, ["0x10", false]);
});

test("/base/tx merges tx + receipt, decodes status", async () => {
  stubRpc({
    eth_getTransactionByHash: {
      from: "0xfrom",
      to: "0xto",
      value: "0xde0b6b3a7640000", // 1e18
      nonce: "0x5",
      blockNumber: "0x64",
    },
    eth_getTransactionReceipt: {
      status: "0x1",
      gasUsed: "0x5208",
      effectiveGasPrice: "0x3b9aca00",
      logs: [{}, {}],
    },
  });
  const res = await handleBase("/base/tx", q("hash=0x" + "a".repeat(64)), env);
  const body = await res.json() as any;
  assert.equal(body.status, "success");
  assert.equal(body.value_eth, "1");
  assert.equal(body.log_count, 2);
  assert.equal(body.blockNumber, 100);
});

test("/base/tx rejects a malformed hash", async () => {
  await assert.rejects(() => handleBase("/base/tx", q("hash=0x123"), env), BaseQueryError);
});

test("/base/tx reports pending when receipt is null", async () => {
  stubRpc({
    eth_getTransactionByHash: { from: "0xf", to: "0xt", value: "0x0", nonce: "0x0", blockNumber: null },
    eth_getTransactionReceipt: null,
  });
  const res = await handleBase("/base/tx", q("hash=0x" + "b".repeat(64)), env);
  const body = await res.json() as any;
  assert.equal(body.status, "pending");
  assert.equal(body.blockNumber, null);
});

test("/base/balance returns native + USDC", async () => {
  stubRpc({
    eth_getBalance: "0x2386f26fc10000", // 0.01 ETH
    eth_call: "0x0000000000000000000000000000000000000000000000000000000005f5e100", // 100 USDC (1e8)
  });
  const res = await handleBase("/base/balance", q("address=0x" + "c".repeat(40)), env);
  const body = await res.json() as any;
  assert.equal(body.eth, "0.01");
  assert.equal(body.usdc, "100");
});

test("/base/balance rejects a bad address", async () => {
  await assert.rejects(() => handleBase("/base/balance", q("address=0xzzz"), env), BaseQueryError);
});

test("/base/erc20 decodes symbol/decimals/balance", async () => {
  stubRpc({
    eth_call: (p: unknown[]) => {
      const data = (p[0] as { data: string }).data;
      if (data === "0x95d89b41") {
        // "USDC" as a dynamic string
        return (
          "0x" +
          "0000000000000000000000000000000000000000000000000000000000000020" +
          "0000000000000000000000000000000000000000000000000000000000000004" +
          "5553444300000000000000000000000000000000000000000000000000000000"
        );
      }
      if (data === "0x313ce567") return "0x0000000000000000000000000000000000000000000000000000000000000006";
      return "0x00000000000000000000000000000000000000000000000000000000000f4240"; // 1e6
    },
  });
  const res = await handleBase("/base/erc20", q("token=0x" + "1".repeat(40) + "&holder=0x" + "2".repeat(40)), env);
  const body = await res.json() as any;
  assert.equal(body.symbol, "USDC");
  assert.equal(body.decimals, 6);
  assert.equal(body.balance, "1");
});

test("/base/gas returns price + base fee", async () => {
  stubRpc({
    eth_gasPrice: "0x3b9aca00", // 1 gwei
    eth_getBlockByNumber: { number: "0x64", baseFeePerGas: "0x1dcd6500" }, // 0.5 gwei
  });
  const res = await handleBase("/base/gas", q(""), env);
  const body = await res.json() as any;
  assert.equal(body.gas_price_gwei, "1");
  assert.equal(body.latest_base_fee_gwei, "0.5");
});

test("unknown /base route is a client error", async () => {
  await assert.rejects(() => handleBase("/base/nonsense", q(""), env), BaseQueryError);
});

test("upstream RPC error surfaces as BaseQueryError", async () => {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { code: -32000, message: "header not found" } })),
    )) as typeof fetch;
  await assert.rejects(() => handleBase("/base/block", q("number=999999999"), env), BaseQueryError);
});

test("decodeAbiString handles bytes32-packed strings", () => {
  const packed = "0x" + Buffer.from("MKR").toString("hex").padEnd(64, "0");
  assert.equal(decodeAbiString(packed), "MKR");
});
