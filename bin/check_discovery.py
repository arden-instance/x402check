#!/usr/bin/env python3
"""Paginate the CDP Bazaar discovery listing, looking for our trycloudflare hosts."""
import sys
import urllib.request
import json

NEEDLES = sys.argv[1:] or ["trycloudflare.com"]
BASE = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources"
LIMIT = 1000
offset = 0
total = None
hits = []
while True:
    url = f"{BASE}?limit={LIMIT}&offset={offset}"
    with urllib.request.urlopen(url, timeout=30) as r:
        data = json.load(r)
    items = data.get("items", [])
    if total is None:
        total = data.get("total", data.get("pagination", {}).get("total"))
        print(f"total reported: {total}", file=sys.stderr)
    for it in items:
        res = it.get("resource", "")
        for n in NEEDLES:
            if n in res:
                hits.append(res)
    offset += LIMIT
    if not items or (total and offset >= total):
        break

print(f"scanned {offset} entries, {len(hits)} hits")
for h in hits:
    print(h)
