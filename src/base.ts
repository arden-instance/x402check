// x402check /base/* — a paid, read-only Base-chain data endpoint.
//
// Thin JSON-RPC proxy over a public Base mainnet node, shaped into small,
// agent-friendly JSON payloads. Same payment gate as /check (pay ~$0.002 USDC
// on Base per call); ~zero marginal upstream cost.
//
//   GET /base/block?number=latest|<decimal|0x-hex>
//   GET /base/tx?hash=0x…            → transaction + receipt summary
//   GET /base/balance?address=0x…    → native ETH + Base USDC balance
//   GET /base/erc20?token=0x…&holder=0x…  → symbol/decimals/balanceOf
//   GET /base/gas                    → gas price + latest base fee
//
// Routing/validation only — no payment logic here (index.ts owns that).

// Public Base mainnet RPCs, tried in order — the first one that answers wins.
// Keyless endpoints only; all rate-limit, so we fail over rather than rely on
// any single one. Override/prepend with the BASE_RPC_URL env (comma-separated).
const DEFAULT_RPCS = [
  "https://base-rpc.publicnode.com",
  "https://rpc.ankr.com/base",
  "https://base.llamarpc.com",
  "https://mainnet.base.org",
];
const RPC_TIMEOUT_MS = 6000;
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TXHASH_RE = /^0x[0-9a-fA-F]{64}$/;

export class BaseQueryError extends Error {}

export interface BaseEnv {
  BASE_RPC_URL?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

interface RpcResult {
  result?: unknown;
  error?: { code: number; message: string };
}

async function rpcOnce(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RPC_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new BaseQueryError(`upstream RPC HTTP ${res.status}`);
  let payload: RpcResult;
  try {
    payload = (await res.json()) as RpcResult;
  } catch {
    throw new BaseQueryError("upstream RPC returned non-JSON");
  }
  // A JSON-RPC error is deterministic (bad params / block not found) — return it
  // to the caller rather than failing over to another node that would say the same.
  if (payload.error) throw new BaseQueryError(`RPC error ${payload.error.code}: ${payload.error.message}`);
  return payload.result;
}

/** Try each RPC in turn; fail over on transport/HTTP errors, propagate JSON-RPC errors. */
async function rpc(rpcUrls: string[], method: string, params: unknown[]): Promise<unknown> {
  let lastErr: unknown;
  for (const u of rpcUrls) {
    try {
      return await rpcOnce(u, method, params);
    } catch (e) {
      lastErr = e;
      // JSON-RPC-level error: deterministic, don't retry other nodes.
      if (e instanceof BaseQueryError && e.message.startsWith("RPC error")) throw e;
    }
  }
  throw new BaseQueryError(
    `all upstream RPCs failed (${rpcUrls.length} tried): ${(lastErr as Error)?.message ?? "unknown"}`,
  );
}

const hexToBigInt = (h: unknown): bigint => (typeof h === "string" && h.startsWith("0x") ? BigInt(h) : 0n);
const hexToNum = (h: unknown): number => Number(hexToBigInt(h));

/** Format an integer token amount (as bigint) to a decimal string with `decimals` places. */
function formatUnits(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  let s = (neg ? -raw : raw).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** Encode `balanceOf(address)` calldata. */
const balanceOfData = (addr: string): string => `0x70a08231${"0".repeat(24)}${addr.slice(2).toLowerCase()}`;

function normaliseBlockTag(raw: string | null): string {
  const v = (raw ?? "latest").trim();
  if (v === "latest" || v === "earliest" || v === "pending" || v === "safe" || v === "finalized") return v;
  if (/^0x[0-9a-fA-F]+$/.test(v)) return v;
  if (/^\d+$/.test(v)) return "0x" + BigInt(v).toString(16);
  throw new BaseQueryError("`number` must be a decimal, 0x-hex, or a named tag (latest/safe/finalized/…)");
}

/**
 * Handle a `/base/*` request. Returns a Response, or throws BaseQueryError
 * for a client-side problem (mapped to 400 by the caller).
 */
export async function handleBase(path: string, params: URLSearchParams, env: BaseEnv): Promise<Response> {
  const configured = (env.BASE_RPC_URL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const rpcUrls = [...configured, ...DEFAULT_RPCS];
  const route = path.replace(/^\/base\/?/, "");

  if (route === "block") {
    const tag = normaliseBlockTag(params.get("number"));
    const b = (await rpc(rpcUrls, "eth_getBlockByNumber", [tag, false])) as Record<string, unknown> | null;
    if (!b) throw new BaseQueryError("block not found");
    return jsonResponse({
      network: "base-mainnet",
      number: hexToNum(b.number),
      hash: b.hash,
      parentHash: b.parentHash,
      timestamp: hexToNum(b.timestamp),
      timestamp_iso: new Date(hexToNum(b.timestamp) * 1000).toISOString(),
      miner: b.miner,
      gasUsed: hexToNum(b.gasUsed),
      gasLimit: hexToNum(b.gasLimit),
      baseFeePerGas_wei: hexToBigInt(b.baseFeePerGas).toString(),
      transaction_count: Array.isArray(b.transactions) ? b.transactions.length : 0,
      retrieved_at: new Date().toISOString(),
    });
  }

  if (route === "tx") {
    const hash = (params.get("hash") ?? "").trim();
    if (!TXHASH_RE.test(hash)) throw new BaseQueryError("`hash` must be a 0x-prefixed 32-byte tx hash");
    const [tx, receipt] = (await Promise.all([
      rpc(rpcUrls, "eth_getTransactionByHash", [hash]),
      rpc(rpcUrls, "eth_getTransactionReceipt", [hash]),
    ])) as [Record<string, unknown> | null, Record<string, unknown> | null];
    if (!tx) throw new BaseQueryError("transaction not found");
    return jsonResponse({
      network: "base-mainnet",
      hash,
      from: tx.from,
      to: tx.to,
      value_wei: hexToBigInt(tx.value).toString(),
      value_eth: formatUnits(hexToBigInt(tx.value), 18),
      nonce: hexToNum(tx.nonce),
      blockNumber: tx.blockNumber == null ? null : hexToNum(tx.blockNumber),
      status: receipt ? (hexToNum(receipt.status) === 1 ? "success" : "reverted") : "pending",
      gasUsed: receipt ? hexToNum(receipt.gasUsed) : null,
      effectiveGasPrice_wei: receipt ? hexToBigInt(receipt.effectiveGasPrice).toString() : null,
      log_count: receipt && Array.isArray(receipt.logs) ? receipt.logs.length : null,
      retrieved_at: new Date().toISOString(),
    });
  }

  if (route === "balance") {
    const address = (params.get("address") ?? "").trim();
    if (!ADDRESS_RE.test(address)) throw new BaseQueryError("`address` must be a 0x-prefixed 20-byte address");
    const [ethWei, usdcRaw] = (await Promise.all([
      rpc(rpcUrls, "eth_getBalance", [address, "latest"]),
      rpc(rpcUrls, "eth_call", [{ to: BASE_USDC, data: balanceOfData(address) }, "latest"]),
    ])) as [string, string];
    return jsonResponse({
      network: "base-mainnet",
      address,
      eth_wei: hexToBigInt(ethWei).toString(),
      eth: formatUnits(hexToBigInt(ethWei), 18),
      usdc_atomic: hexToBigInt(usdcRaw).toString(),
      usdc: formatUnits(hexToBigInt(usdcRaw), 6),
      retrieved_at: new Date().toISOString(),
    });
  }

  if (route === "erc20") {
    const token = (params.get("token") ?? "").trim();
    const holder = (params.get("holder") ?? "").trim();
    if (!ADDRESS_RE.test(token)) throw new BaseQueryError("`token` must be a 0x-prefixed contract address");
    if (!ADDRESS_RE.test(holder)) throw new BaseQueryError("`holder` must be a 0x-prefixed address");
    const [symHex, decHex, balHex] = (await Promise.all([
      rpc(rpcUrls, "eth_call", [{ to: token, data: "0x95d89b41" }, "latest"]), // symbol()
      rpc(rpcUrls, "eth_call", [{ to: token, data: "0x313ce567" }, "latest"]), // decimals()
      rpc(rpcUrls, "eth_call", [{ to: token, data: balanceOfData(holder) }, "latest"]), // balanceOf()
    ])) as [string, string, string];
    const decimals = hexToNum(decHex);
    return jsonResponse({
      network: "base-mainnet",
      token,
      holder,
      symbol: decodeAbiString(symHex),
      decimals,
      balance_atomic: hexToBigInt(balHex).toString(),
      balance: formatUnits(hexToBigInt(balHex), decimals || 0),
      retrieved_at: new Date().toISOString(),
    });
  }

  if (route === "gas") {
    const [price, block] = (await Promise.all([
      rpc(rpcUrls, "eth_gasPrice", []),
      rpc(rpcUrls, "eth_getBlockByNumber", ["latest", false]),
    ])) as [string, Record<string, unknown>];
    return jsonResponse({
      network: "base-mainnet",
      gas_price_wei: hexToBigInt(price).toString(),
      gas_price_gwei: formatUnits(hexToBigInt(price), 9),
      latest_base_fee_wei: hexToBigInt(block.baseFeePerGas).toString(),
      latest_base_fee_gwei: formatUnits(hexToBigInt(block.baseFeePerGas), 9),
      block_number: hexToNum(block.number),
      retrieved_at: new Date().toISOString(),
    });
  }

  throw new BaseQueryError(`unknown /base route '${route}'. Valid: block, tx, balance, erc20, gas`);
}

/** Decode a single ABI-encoded string return value (offset, length, bytes). */
export function decodeAbiString(hex: unknown): string {
  if (typeof hex !== "string" || !hex.startsWith("0x")) return "";
  const body = hex.slice(2);
  // Some tokens (e.g. MKR) return a bytes32 packed string instead of a dynamic string.
  if (body.length === 64) {
    const bytes = body.replace(/(00)+$/, "");
    return hexBytesToUtf8(bytes);
  }
  if (body.length < 128) return "";
  const len = Number(BigInt("0x" + body.slice(64, 128)));
  const strHex = body.slice(128, 128 + len * 2);
  return hexBytesToUtf8(strHex);
}

function hexBytesToUtf8(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  try {
    return new TextDecoder().decode(bytes).replace(/ +$/, "");
  } catch {
    return "";
  }
}

export { jsonResponse as _baseJsonResponse };
