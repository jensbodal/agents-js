#!/usr/bin/env python3
"""
AJS-55 peer-record byte-fixture oracle.

Independent oracle for the `byte fixture` test in
`packages/host/tests/peer-record.test.ts`. Produces the expected sig
value for a hardcoded {record, privkey} triple via a different code
path (Python `cryptography` library) than the TypeScript impl
(`packages/host/src/peer-record.ts` + Node's `crypto.sign(null, ...)`).
A bug in the TypeScript impl is unlikely to be mirrored in this oracle,
so the test catches first-run impl bugs that capture-then-regress would
silently bake in (advisor flagged byte-fixture circularity 2026-05-22).

Run: `python3 packages/host/tests/_oracles/peer-record-byte-fixture.py`

Output: prints the base64-encoded sig that should appear inline in the
test as `EXPECTED_PEER_RECORD_SIG_FIXTURE`. If the TS impl is correct,
running this script and the test produce identical sig values; if they
diverge, one of them has a bug (likely the impl).
"""

import base64
import json
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

# Fixed 32-byte ed25519 seed → deterministic test-only keypair.
# NEVER use this seed for any real identity; it's published in the repo.
TEST_SEED = bytes(range(32))  # 0x00, 0x01, ..., 0x1f

PRIV = Ed25519PrivateKey.from_private_bytes(TEST_SEED)
PUB = PRIV.public_key()
PUB_RAW = PUB.public_bytes_raw()  # 32 bytes
PUB_B64 = base64.b64encode(PUB_RAW).decode("ascii")

# Fixed unsigned peer record. The JCS canonicalization will sort keys
# lexicographically by UTF-16 code-unit order (which for these ASCII
# keys matches Python's default dict-key iteration sort order). The
# Python json.dumps with sort_keys=True + separators=(",", ":") produces
# the same byte sequence as the TS impl's JCS encoder for this record
# (no nested non-ASCII strings or non-finite numbers in the fixture).
RECORD = {
    "entity": "test-fixture-entity",
    "pubkey": PUB_B64,
    "capabilities": {
        "scopes": ["matrix.send_message", "inbox.read"],
        "matrix": {"room": "!testroom:example.com"},
    },
    "signed_at": "2026-05-22T18:00:00Z",
    "signer": "fleet-root",
}

DOMAIN_SEPARATOR = "agents-js:peer-record:v1"


def jcs_minimal(value):
    """
    JCS-compatible canonical JSON for the AJS-55 fixture record. This
    matches the TypeScript JCS encoder's output for this specific
    record shape (all ASCII strings, no special escapes needed beyond
    the standard JSON ones, sorted keys at every nesting level).

    For the general JCS spec see RFC 8785; this implementation is
    sufficient for the fixture but does NOT cover the full RFC (e.g.
    no special number serialization).
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def main():
    jcs_str = jcs_minimal(RECORD)
    jcs_bytes = jcs_str.encode("utf-8")
    domain_bytes = DOMAIN_SEPARATOR.encode("utf-8")
    signed_bytes = domain_bytes + b"\x0a" + jcs_bytes

    sig = PRIV.sign(signed_bytes)
    sig_b64 = base64.b64encode(sig).decode("ascii")

    print("=== AJS-55 peer-record byte-fixture oracle ===")
    print()
    print(f"Test pubkey (base64, 32 bytes raw):  {PUB_B64}")
    print(f"Domain separator:                    {DOMAIN_SEPARATOR}")
    print(f"JCS-canonical record bytes (utf-8):  {jcs_str}")
    print(f"Signed-bytes length:                 {len(signed_bytes)} bytes")
    print(f"  (domain {len(domain_bytes)} + 0x0A + jcs {len(jcs_bytes)})")
    print()
    print("EXPECTED_PEER_RECORD_SIG_FIXTURE:")
    print(f'  "{sig_b64}"')
    print()
    print("Paste the above base64 string into peer-record.test.ts as the")
    print("EXPECTED_PEER_RECORD_SIG_FIXTURE constant.")


if __name__ == "__main__":
    main()
