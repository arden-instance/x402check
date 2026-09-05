// web.ts — the free browser-facing UI for x402check.
//
// x402check's paid `GET /check` is for agents that need an inline conformance
// verdict mid-payment-flow. A human who lands on the URL (from a blog post, a
// GitHub link, an x402scan.com listing) can't pay from a browser and just sees
// JSON — so they bounce. This page gives them a zero-install checker that hits
// the free, rate-limited `GET /check-free?url=` endpoint and renders the result.
//
// No framework, no external assets, no build step: one self-contained HTML
// string that works in light and dark.

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>x402check — x402 conformance pre-flight</title>
<meta name="description" content="Check any x402 endpoint's 402 challenge for spec conformance before you trust it with a real payment. Free in the browser; paid API for agents.">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    margin: 0; padding: 2.5rem 1.25rem 4rem;
    background: Canvas; color: CanvasText;
  }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin: 0 0 .3rem; }
  .tag { color: color-mix(in srgb, CanvasText 55%, Canvas); margin: 0 0 1.75rem; }
  form { display: flex; gap: .5rem; flex-wrap: wrap; }
  input[type=url] {
    flex: 1 1 22rem; padding: .6rem .7rem; font: inherit;
    border: 1px solid color-mix(in srgb, CanvasText 35%, Canvas);
    border-radius: 7px; background: Field; color: FieldText;
  }
  button {
    padding: .6rem 1.1rem; font: inherit; font-weight: 600; cursor: pointer;
    border: 1px solid transparent; border-radius: 7px;
    background: color-mix(in srgb, CanvasText 88%, Canvas); color: Canvas;
  }
  button:disabled { opacity: .55; cursor: progress; }
  #out { margin-top: 1.75rem; }
  .verdict { display: inline-block; padding: .25rem .7rem; border-radius: 6px; font-weight: 700; letter-spacing: .02em; }
  .PASS { background: #1a7f371f; color: #1a7f37; }
  .WARN { background: #9a6c001f; color: #9a6c00; }
  .FAIL { background: #cf222e1f; color: #cf222e; }
  @media (prefers-color-scheme: dark) {
    .PASS { color: #3fb950; } .WARN { color: #d29922; } .FAIL { color: #f85149; }
  }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; font-size: .92rem; }
  td { padding: .4rem .5rem; border-top: 1px solid color-mix(in srgb, CanvasText 15%, Canvas); vertical-align: top; }
  td.lvl { white-space: nowrap; font-weight: 600; width: 3.2rem; }
  td.lvl.PASS { color: #1a7f37; } td.lvl.WARN { color: #9a6c00; } td.lvl.FAIL { color: #cf222e; } td.lvl.INFO { color: color-mix(in srgb, CanvasText 55%, Canvas); }
  @media (prefers-color-scheme: dark) {
    td.lvl.PASS { color: #3fb950; } td.lvl.WARN { color: #d29922; } td.lvl.FAIL { color: #f85149; }
  }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88em; }
  .err { color: #cf222e; } @media (prefers-color-scheme: dark) { .err { color: #f85149; } }
  footer { margin-top: 3rem; font-size: .85rem; color: color-mix(in srgb, CanvasText 50%, Canvas); }
  a { color: inherit; }
</style>
</head>
<body>
<main>
  <h1>x402check</h1>
  <p class="tag">Paste an x402 endpoint. Get a PASS / WARN / FAIL verdict on its
  <code>402</code> challenge before you trust it with a real payment.</p>

  <form id="f">
    <input type="url" id="url" name="url" required placeholder="https://api.example.com/paid-resource"
      autocomplete="off" autocapitalize="off" spellcheck="false">
    <button type="submit" id="go">Check</button>
  </form>

  <div id="out" aria-live="polite"></div>

  <footer>
    Free and rate-limited &mdash; for programmatic use, agents call the paid
    <code>GET /check?url=</code> endpoint (~$0.002 USDC on Base per call).
    <a href="/openapi.json">OpenAPI</a> &middot;
    <a href="https://github.com/arden-instance/x402check">source</a> &middot;
    <a href="https://arden-instance.github.io/x402-conformance.html">conformance leaderboard</a>
  </footer>
</main>
<script>
const f = document.getElementById('f'), out = document.getElementById('out'), go = document.getElementById('go');
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
f.addEventListener('submit', async e => {
  e.preventDefault();
  const u = document.getElementById('url').value.trim();
  if (!u) return;
  go.disabled = true; out.innerHTML = '<p>Checking…</p>';
  try {
    const r = await fetch('/check-free?url=' + encodeURIComponent(u), { headers: { accept: 'application/json' } });
    const d = await r.json();
    if (!r.ok) { out.innerHTML = '<p class="err">' + esc(d.error || ('HTTP ' + r.status)) + (d.detail ? ': ' + esc(d.detail) : '') + '</p>'; return; }
    const rows = (d.checks || []).map(c =>
      '<tr><td class="lvl ' + esc(c.level) + '">' + esc(c.level) + '</td><td><code>' + esc(c.id) + '</code></td><td>' + esc(c.message) + '</td></tr>'
    ).join('');
    out.innerHTML =
      '<p><span class="verdict ' + esc(d.verdict) + '">' + esc(d.verdict) + '</span> '
      + '&nbsp; wire v' + esc(d.wire_version ?? '?') + ' &nbsp; '
      + esc(d.counts.PASS) + ' pass / ' + esc(d.counts.WARN) + ' warn / ' + esc(d.counts.FAIL) + ' fail</p>'
      + '<table><tbody>' + rows + '</tbody></table>';
  } catch (err) {
    out.innerHTML = '<p class="err">' + esc(err) + '</p>';
  } finally {
    go.disabled = false;
  }
});
</script>
</body>
</html>`;

export function renderPage(): Response {
  return new Response(PAGE, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=600",
    },
  });
}

// wantsHtml — true when the client is a browser navigating to the page, not a
// tool/agent hitting `/` for the JSON service descriptor.
export function wantsHtml(req: Request): boolean {
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("text/html");
}

// --- free-tier rate limiting -------------------------------------------------
// No KV / Durable Object: a module-level sliding window keyed by client IP.
// Per-isolate, so it's a soft cap (an abuser spread across colos gets more) —
// enough to keep the free browser tool from being scripted as a free API.
const RL_WINDOW_MS = 60_000;
const RL_MAX = 20;
const hits = new Map<string, number[]>();

export function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < RL_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) {
    // bound memory: drop the oldest-touched entries
    for (const k of [...hits.keys()].slice(0, 2500)) hits.delete(k);
  }
  return arr.length > RL_MAX;
}
