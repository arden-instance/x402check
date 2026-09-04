// Deno Deploy entrypoint — a thin adapter over the Cloudflare-Workers handler in
// src/index.ts. The core logic (protocol / fetch / payments) is runtime-neutral:
// it uses only Web Crypto, fetch, URL, Request/Response — all native to Deno.
//
// The only shape difference is config delivery: CF Workers pass an `env` object
// as the 2nd fetch() arg; Deno Deploy exposes env vars via Deno.env. This proxy
// bridges the two so src/index.ts needs no changes.
//
//   deno run --allow-net --allow-env deno_entry.ts
//
// Deploy: `deployctl deploy --entrypoint=deno_entry.ts` (or the Deno Deploy
// GitHub integration pointed at this file).

import handler, { type Env } from "./src/index.ts";

const env = new Proxy(
  {},
  { get: (_t, key) => Deno.env.get(String(key)) ?? undefined },
) as Env;

const port = Number(Deno.env.get("PORT") ?? "8000");
Deno.serve({ port }, (req: Request) => handler.fetch(req, env));
