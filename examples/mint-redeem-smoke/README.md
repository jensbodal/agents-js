# @agents-js/example-mint-redeem-smoke

Smoke example for the AJS-55 cryptographic challenge-mint flow, driven
through the real gateway mount handler
([`setupAgentsMcpMount`](../../apps/internal-gateway/agents-mcp-mount.ts)).

Demonstrates, exactly as an external peer would over HTTP:

- `POST /api/agents/mint/challenge` → a single-use 32-byte challenge.
- ed25519-signing the canonical signed bytes
  (`domain-separator || 0x0A || JCS({challenge, entity, requested_scopes})`)
  via the public `buildChallengeMintSignedBytes` helper.
- `POST /api/agents/mint/redeem` → a JWT whose `scopes` claim is
  **exactly** the requested scopes — verified by decoding the JWT, not
  trusting the response body (no silent downgrade).
- Replaying a redeemed challenge → `401 invalid-challenge` (single-use).
- The per-IP token-bucket rate limiter → `429` + `Retry-After` once the
  burst is exhausted.

The only test seams are a mock `PeerKeyDirectory` (an in-memory ed25519
keypair registered under one entity) and a tight `ipRateLimiter`
override. Everything else is the production substrate.

## Test

```bash
bun run --cwd examples/mint-redeem-smoke test
```

## Layout

```
examples/mint-redeem-smoke/
  package.json          # workspace example, private
  tsconfig.json         # extends ../../tsconfig.workspace.json
  tests/smoke.test.ts   # challenge → sign → redeem → JWT + replay + rate-limit
  README.md             # this file
```
