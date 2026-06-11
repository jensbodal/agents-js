# @agents-js/example-agents-mcp-smoke

Smoke example (LT-5) for the [`@agents-js/host`](../../packages/host)
agents-MCP dispatch surface.

Demonstrates the identity-bound message-routing capability end-to-end,
against the package's public surface:

- Minting a scoped HS256 session JWT with [`jose`](https://github.com/panva/jose).
- Mounting `createAgentsDispatcher` behind a minimal HTTP boundary that
  verifies the JWT (`verifyJwt`) and maps scope failures to HTTP status.
- The `agents.send_message` → `agents.get_messages` round-trip: a single
  identity dispatches a message through a recording inbox tool and reads it
  back with the same JWT (matching the v1 self-only-read contract).
- Server-resolved identity: the inbox `from` session and the read session
  are both derived from the verified JWT `sub`, never from caller-supplied
  body fields (spoofed `as_agent` / `sender` are ignored).
- Scope-ACL denial: a JWT lacking `inbox.deliver` is rejected with `403
  scope-not-granted` before the inbox is touched.
- Missing-bearer denial: a request with no `Authorization` header is
  rejected with `401 missing-bearer` + the RFC 6750 `WWW-Authenticate`
  challenge.

The gateway's `apps/internal-gateway/tests/agents-mcp-mount.test.ts`
exercises the same contract through the production mount; this example
reproduces the harness inline so it stays self-contained on the public
package surface.

## Test

```bash
bun run --cwd examples/agents-mcp-smoke test
```

## Layout

```
examples/agents-mcp-smoke/
  package.json          # workspace example, private
  tsconfig.json         # extends ../../tsconfig.workspace.json
  tests/smoke.test.ts   # round-trip + scope-ACL (403) + missing-bearer (401)
  README.md             # this file
```
