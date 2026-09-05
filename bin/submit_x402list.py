#!/usr/bin/env python3
"""Submit x402check to x402-list.com (POST /api/v1/submit).

workers.dev is on x402-list's free-compute-host list, so the submit endpoint
answers HTTP 402 with a one-off $1 USDC (Base) charge that "buys a place in the
human review queue, not a listing". Pay it from the mainnet agent wallet with
x402lint's offline EIP-3009 signer, then retry.

Usage:
    python3 bin/submit_x402list.py            # probe only: POST unpaid, print the 402
    python3 bin/submit_x402list.py --pay      # probe, then sign+pay+retry
"""
import base64
import json
import subprocess
import sys
import urllib.request

sys.path.insert(0, "/home/claude/agent/workspace/x402lint/src")
from x402lint.pay import (  # noqa: E402
    challenge_document,
    select_exact_entry,
    prepare_payment,
)

SUBMIT_URL = "https://x402-list.com/api/v1/submit"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
KEY_SECRET = "crypto/base/agent-wallet/private-key"

# Expected charge: one-off free-host fee, $1 USDC on Base.
EXPECT_NETWORK = "eip155:8453"
EXPECT_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"  # native USDC on Base
EXPECT_AMOUNT_MAX = 1_500_000  # refuse anything above $1.50 (free-host + resubmit stack ceiling)

BODY = {
    "url": "https://x402check.arden-instance.workers.dev",
    "email": "arden.instance@gmail.com",
    "service_name": "x402check",
    "description": (
        "Live x402 conformance pre-flight check. Pass ?url=<x402 endpoint> and get a "
        "structured PASS/WARN/FAIL verdict on its HTTP 402 challenge — wire-version "
        "detection, EIP-712 domain completeness, accepts[] schema validity, payTo and "
        "amount sanity — before you trust it with a real payment."
    ),
    "website_url": "https://github.com/arden-instance/x402check",
    "category": "Verification",
    "endpoints": ["/check"],
    "notes": (
        "Agent-first: one paid GET endpoint, /check?url=<endpoint>, ~$0.002 USDC on Base, "
        "settled via the Coinbase CDP mainnet facilitator (payTo "
        "0xceEc1c3F6CD66dC7c91fae0e232Eac0d346564e9). Free unpaid routes: / , /healthz , "
        "/openapi.json . Also deployed on ngrok (disagree-gem-colossal.ngrok-free.dev) as "
        "a redundant instance. Source: github.com/arden-instance/x402check."
    ),
}


def _post(body_obj, payment_header_value=None):
    data = json.dumps(body_obj).encode()
    headers = {"User-Agent": UA, "Content-Type": "application/json", "Accept": "application/json"}
    if payment_header_value:
        # x402-list's 402 text names PAYMENT-SIGNATURE; the generic x402 flow uses
        # X-PAYMENT. Send both so whichever the server reads is present.
        headers["PAYMENT-SIGNATURE"] = payment_header_value
        headers["X-PAYMENT"] = payment_header_value
    req = urllib.request.Request(SUBMIT_URL, data=data, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return r.status, dict(r.headers.items()), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers.items()), e.read()


def main():
    do_pay = "--pay" in sys.argv

    status, headers, body = _post(BODY)
    print(f"--- unpaid POST -> HTTP {status}")
    try:
        print(json.dumps(json.loads(body), indent=2))
    except Exception:
        print(body[:2000])

    if status == 201:
        print("\nAccepted with no payment required (own-domain path). Done.")
        return 0
    if status != 402:
        print(f"\nUnexpected status {status}; not proceeding.")
        return 1

    doc = challenge_document(status, headers, body)
    entry = select_exact_entry(doc)
    amount = int(entry.get("amount") or entry.get("maxAmountRequired"))
    print("\n--- 402 challenge accepts[0] ---")
    print(json.dumps(entry, indent=2))
    print(f"\nnetwork={entry.get('network')} asset={entry.get('asset')} "
          f"amount={amount} ({amount/1e6:.2f} USDC) payTo={entry.get('payTo')}")
    print(f"error={doc.get('error')!r} message={doc.get('message')!r}")

    # Safety gates before spending.
    problems = []
    if entry.get("network") != EXPECT_NETWORK:
        problems.append(f"network {entry.get('network')} != {EXPECT_NETWORK}")
    if (entry.get("asset") or "").lower() != EXPECT_ASSET.lower():
        problems.append(f"asset {entry.get('asset')} != USDC {EXPECT_ASSET}")
    if amount > EXPECT_AMOUNT_MAX:
        problems.append(f"amount {amount} exceeds ceiling {EXPECT_AMOUNT_MAX}")
    if problems:
        print("\nREFUSING TO PAY:\n  " + "\n  ".join(problems))
        return 1

    if not do_pay:
        print("\nProbe only. Re-run with --pay to sign and submit the payment.")
        return 0

    pk = subprocess.run(
        ["pass", "show", KEY_SECRET], capture_output=True, text=True, check=True
    ).stdout.strip()

    prep = prepare_payment(entry, pk, x402_version=2)
    # x402lint's payment_payload() emits the v1-style flat envelope
    # ({x402Version, scheme, network, payload}); x402-list wants the v2 envelope
    # from the spec: the selected requirement nested under "accepted", the
    # resource echoed, plus an "extensions" object. Assemble it by hand.
    v2_payload = {
        "x402Version": 2,
        "accepted": entry,
        "payload": {
            "signature": prep["signature"],
            "authorization": prep["authorization"],
        },
        "extensions": {},
    }
    if isinstance(doc.get("resource"), dict):
        v2_payload["resource"] = doc["resource"]
    print("\n--- PaymentPayload (v2 envelope) ---")
    print(json.dumps(v2_payload, indent=2))
    header_val = base64.b64encode(
        json.dumps(v2_payload, separators=(",", ":")).encode()
    ).decode()

    print("\n--- retrying POST with payment ---")
    status2, headers2, body2 = _post(BODY, header_val)
    print(f"HTTP {status2}")
    try:
        print(json.dumps(json.loads(body2), indent=2))
    except Exception:
        print(body2[:2000])
    pr = headers2.get("X-PAYMENT-RESPONSE") or headers2.get("PAYMENT-RESPONSE")
    if pr:
        print("PAYMENT-RESPONSE:", pr)
    return 0 if status2 in (200, 201) else 1


if __name__ == "__main__":
    sys.exit(main())
