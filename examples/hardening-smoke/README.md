# @agents-js/example-hardening-smoke

Hardening smoke for [`@agents-js/host`](../../packages/host) — the HS256
JWT **mint → verify → reject** security loop, end-to-end.

Demonstrates, against the public package surface a real consumer imports:

- Minting a scoped HS256 JWT (`jose` `SignJWT`) the way the gateway-side
  minter does — `sub` / `scopes` / `cid` / `iss` / `aud` / `exp`.
- Verifying it with the correct signing key + issuer + audience via
  `verifyJwt`, resolving a typed `AuthenticatedIdentity`.
- Rejecting the failure modes that matter at the deployment boundary:
  - wrong signing key → `signature-invalid`,
  - a byte-flipped/forged token → `signature-invalid`,
  - an HS512-same-key algorithm substitution → `signature-invalid`,
  - an expired token (`exp` in the past) → `expired`.
- The `extractBearerToken` → `verifyJwt` header round-trip, so the loop
  is exercised the way middleware sees it.

## Test

```bash
bun run --cwd examples/hardening-smoke test
```

## Typecheck

```bash
bun run --cwd examples/hardening-smoke typecheck
```

## Layout

```
examples/hardening-smoke/
  package.json          # workspace example, private
  tsconfig.json         # extends ../../tsconfig.workspace.json
  tests/smoke.test.ts   # mint → verify → reject assertions
  README.md             # this file
```
