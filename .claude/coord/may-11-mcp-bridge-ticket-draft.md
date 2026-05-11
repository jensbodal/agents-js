# AJS-N MCP bridge for gateway push channel (ticket draft)

**Status**: DRAFT scope for a new AJS ticket. Replaces DOT-396 which was
cancelled/absorbed-into-DOT-398-then-AJS-8 earlier; per @jensbodal's
2026-05-11 lock, the MCP component is scoped OUT of AJS-8 and lives in
its own ticket. Local artifact under `.claude/coord/`; canonical AC text
lands in Plane once filed.

## Title

**AJS-N — MCP bridge for gateway push channel**

## Premise

AJS-8 ships the gateway-side server-push channel (event bus + SSE
subscribe + admin publish + internal publishers). AJS-8 emits in its
native A2A-shaped envelope. MCP-speaking clients (Claude Code,
opencode, etc.) cannot directly consume that — MCP has its own
JSON-RPC-based `notifications/*` shape and its own transport
expectations (server-initiated notifications over a client-opened
connection).

This ticket scopes a **separate service workload** that:

1. Subscribes to the AJS-8 gateway bus via the SSE endpoint as a
   gateway-bus consumer (no special privilege; uses the same SSE
   transport any AJS-8 subscriber uses).
2. Accepts MCP client connections (per the MCP server lifecycle —
   stdio or streamable-HTTP per the MCP spec).
3. Translates gateway bus events → MCP `notifications/*` shapes and
   delivers them to the appropriate MCP clients.

## Scope (v1)

The MCP bridge is a separate process, packaged and deployed
independently from the agents-js gateway. It does TWO distinct
translation jobs:

### Job 1 — Wire-format translation

Take a `GatewayBusEvent<TPayload>` arriving on the SSE stream and emit
it as an MCP-spec `notifications/*` method call on the appropriate
client's JSON-RPC connection.

- Event type → MCP method name mapping (table maintained alongside the
  bridge)
- Event payload → MCP notification `params` (preserving the named-field
  structure from AJS-8's payload — no flattening into JSON-RPC envelope
  fields)
- Event metadata slots (`sourcePrincipal`, `correlationId`) → MCP
  notification `params._meta` or equivalent extension surface

### Job 2 — Transport bridge

Route bus events back over each connected MCP client's existing
JSON-RPC connection. MCP server-initiated notifications travel on the
connection the client opened to call tools; they are not sent over a
separate server-initiated channel.

- Per-MCP-client connection-state tracking: bridge maintains a map of
  `{ clientId → JSON-RPC connection handle, subscribed-topic filter }`
- When a bus event arrives: filter against each client's subscription,
  send to matching clients via their respective connections
- Connection lifecycle: bridge handles MCP client connect / disconnect
  / reconnect cleanly; subscription state survives transient reconnects
  but does not persist across full bridge restarts (v1)

## Scope guards (v1)

1. **Does NOT impersonate the gateway.** The bridge has its own
   identity (its own MCP server name / version surface). MCP clients
   connect to "MCP bridge for agents-js" — not to "the agents-js
   gateway." The bridge is a consumer that re-shapes for downstream
   consumption.
2. **Read-only consumer.** v1 does not allow MCP clients to publish
   into the gateway bus via the bridge. Bus inputs flow only through
   AJS-8's own admin/publisher API.
3. **Trusted-network only** (matches AJS-8 v1).
4. **No identity enforcement** in v1. Bridge forwards source principal
   and correlation slots if present on the bus event; does not validate
   them. DOT-392 phase 2+ owns enforcement.
5. **No durable delivery.** v1 forwards live events only — MCP clients
   that connect while events are happening receive new events; missed
   events are not replayed. Matches AJS-8 v1's in-memory pub/sub.

## Out of scope (explicit)

- **Identity verification / signing** — DOT-392 phase 2+.
- **Durable subscription / replay** — v2 concern; would require AJS-8 to
  ship durable storage first.
- **MCP server impersonating other agents** — bridge identity is the
  bridge itself; not a generic "agent registry" surface.
- **MCP-to-bus reverse path** — MCP clients cannot publish via the
  bridge in v1; bus inputs are AJS-8 publishers only.

## Acceptance criteria

- [ ] Service binary (likely `@agents-js/mcp-bridge` package) that:
  - On startup, opens an SSE connection to a configured AJS-8 gateway
    URL.
  - Accepts MCP client connections per MCP server lifecycle.
- [ ] Wire-format translation: at least 3 bus event topics translated
      to MCP notification methods, with a documented mapping table:
  - `gateway.session.*`
  - `gateway.harness.*`
  - `gateway.permission.*`
- [ ] Per-client connection-state tracking: bridge maintains a map of
      MCP clients and routes events to the right connections.
- [ ] Subscription filter: MCP clients can subscribe to a subset of
      bus topics via a request method (e.g. `subscriptions/set`).
- [ ] Disconnect handling: when an MCP client disconnects, the bridge
      cleans up its subscription state without leaking.
- [ ] Reconnect handling: when the bridge's SSE connection to AJS-8
      drops, it retries with backoff; live MCP clients see no error
      until backoff is exhausted.
- [ ] Test coverage:
  - Unit: wire-format translator (event → notification mapping)
  - Integration: bridge ↔ live AJS-8 SSE ↔ live MCP client; full path
    Matrix-event → AJS-8 → bridge → MCP notification
  - Edge: SSE disconnect mid-stream, MCP client disconnect, multiple
    MCP clients with disjoint subscriptions

## Cross-references

- **AJS-8** (gateway push channel): upstream dependency. This ticket
  consumes AJS-8's SSE endpoint.
- **DOT-396** (cancelled): superseded by AJS-8 + this ticket. The
  original push-notification scope split into "the bus" (AJS-8) and
  "the MCP adapter" (this ticket).
- **`docs/_internal/agent-gateway-separation.md`**: anchor doc. The MCP
  bridge sits outside the gateway/host/runtime tripod — it's a
  separate consumer service that lives at the gateway↔consumer
  boundary, not inside any of the three core layers.
- **DOT-392** (identity model): bridge will adopt phase 1 types for
  source-principal slot forwarding; phase 2+ enforcement lands later.

## Open coord questions

1. **Package location.** Bridge could live as:
   - **(a)** `packages/mcp-bridge/` inside the agents-js monorepo,
     shipped as a separate binary
   - **(b)** Standalone repo (`agents-js-mcp-bridge`?)
   - **(c)** Sub-package inside `apps/` (`apps/mcp-bridge/`?)

   Default-yes: **(a)**, lives in the monorepo as `packages/mcp-bridge/`
   for proximity to the bus types it depends on, but ships as its own
   binary so deployments can place it anywhere.

2. **MCP transport mode.** MCP spec supports both stdio and
   streamable-HTTP transports. v1 could be:
   - **(a)** stdio only (matches how Claude Code launches MCP servers)
   - **(b)** streamable-HTTP only (matches a long-lived service shape)
   - **(c)** both

   Default-yes: **(a)** for v1. Claude Code is the immediate consumer;
   stdio is its native transport. (b) and (c) are follow-up if other
   MCP clients require HTTP.

3. **Ticket number.** Will be assigned at filing. Cross-reference will
   be added back to AJS-8 once known.

## Implementation gating

Like AJS-8 and AJS-7, execution requires explicit agents-js owner
approval per the active-tree freeze. This ticket is design-only until
gated.

— ajs-claude (peer session) 2026-05-11
