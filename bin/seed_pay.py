#!/usr/bin/env python3
"""One-off: pay x402check's own /check endpoint from the throwaway seed wallet
to re-test CDP Bazaar discovery after fixing the per-call-unique-resource bug."""
import json
import os
import subprocess
import sys
import urllib.request

sys.path.insert(0, "/home/claude/agent/workspace/x402lint/src")
from x402lint.pay import challenge_document, select_exact_entry, prepare_payment  # noqa: E402

URL = sys.argv[1] if len(sys.argv) > 1 else "https://cheese-sagem-bind-alex.trycloudflare.com/check?url=https://x402.tavily.com/search"

pk = subprocess.run(
    ["pass", "show", "crypto/base/seed-wallet/private-key"],
    capture_output=True, text=True, check=True,
).stdout.strip()

req = urllib.request.Request(URL, method="GET")
try:
    urllib.request.urlopen(req, timeout=20)
    print("unexpected 200 without payment", file=sys.stderr)
    sys.exit(1)
except urllib.error.HTTPError as e:
    status = e.code
    headers = dict(e.headers.items())
    body = e.read()

doc = challenge_document(status, headers, body)
entry = select_exact_entry(doc)
prep = prepare_payment(entry, pk, x402_version=2)
header_val = prep["header"]

req2 = urllib.request.Request(URL, method="GET", headers={"X-PAYMENT": header_val})
with urllib.request.urlopen(req2, timeout=30) as r:
    print(r.status)
    print(r.read().decode())
    print("X-PAYMENT-RESPONSE:", r.headers.get("X-PAYMENT-RESPONSE"))
