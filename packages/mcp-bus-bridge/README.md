# @agents-js/mcp-bus-bridge

<!-- This README is hand-maintained. -->

MCP server that bridges an agents-js gateway's event bus to any
MCP-speaking client (Claude Code, Claude Desktop, Cursor, etc.) as
server-initiated notifications.

The bridge runs as a stdio MCP subprocess: the client spawns it, the
bridge connects to the gateway's `/events` SSE endpoint, and every bus
event is fanned out as an MCP notification the client receives in
context. No tools are exposed — this is notifications-only by design,
so tool surfaces stay on whatever curated MCP gateway the client
already uses (mcpjungle, etc.).

## Install

The package ships a single `agents-js-mcp-bus-bridge` binary. Install
the package in the environment where the MCP client will spawn it:

```sh
bun add -g @agents-js/mcp-bus-bridge
# or
npm install -g @agents-js/mcp-bus-bridge
```

Or run directly from a clone:

```sh
bun /path/to/agents-js/packages/mcp-bus-bridge/src/bin.ts
```

## Wire it into your MCP client

The bridge is configured entirely through env vars passed by the MCP
client at spawn time. A minimal Claude Code config:

```json
{
  "mcpServers": {
    "gateway-bus": {
      "command": "agents-js-mcp-bus-bridge",
      "env": {
        "GATEWAY_BUS_URL": "http://localhost:8080",
        "GATEWAY_BUS_FILTER": "gateway.harness.,gateway.session.,gateway.matrix."
      }
    }
  }
}
```

The bridge subscribes to the gateway's `/events` SSE endpoint at
`$GATEWAY_BUS_URL` and forwards every event whose `type` starts with
one of the comma-separated `GATEWAY_BUS_FILTER` prefixes. Set
`GATEWAY_BUS_FILTER=*` (or leave unset) to receive everything.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GATEWAY_BUS_URL` | `http://localhost:8080` | Base URL of the gateway exposing `/events`. |
| `GATEWAY_BUS_SUBSCRIBE_PATH` | `/events` | SSE subscribe path on the gateway. |
| `GATEWAY_BUS_FILTER` | `*` | Comma-separated topic prefixes to forward, or `*` for all. |
| `GATEWAY_BUS_RECONNECT_MIN_MS` | `1000` | Initial reconnect delay after an SSE disconnect. |
| `GATEWAY_BUS_RECONNECT_MAX_MS` | `60000` | Maximum reconnect delay (exponential backoff caps here). |

## Topics emitted by the gateway

The gateway publishes a small set of topic prefixes that the bridge
forwards as-is. Use the prefix in `GATEWAY_BUS_FILTER` to subscribe to
a subset:

| Topic prefix | Emitted when |
|---|---|
| `gateway.audit.*` | Every recorded audit event (broadest surface; one event per `AuditEmitter.record(...)`). |
| `gateway.harness.child-spawned` | A harness child process is spawned (lazy session start). |
| `gateway.harness.child-exited` | A harness child process exits (clean or crash). |
| `gateway.harness.card-changed` | A harness's agent-card slice mutates (capability changes, primary flip). |
| `gateway.session.*` | ACPSessionController lifecycle events (session created, ended, etc.). |
| `gateway.matrix.event-received` | An external Matrix bridge publishes a Matrix event onto the gateway bus. |

Adding new topics is a gateway-side change (see
`packages/host/src/gateway-bus-publishers.ts` and individual extras
under `extras/`). The bridge forwards anything that matches the
filter without further enumeration.

## Notification shape

Each bus event becomes an MCP notification of method
`notifications/message` with the gateway envelope as the
notification's `params`. The envelope shape is the
`GatewayBusEvent<TPayload>` from `@agents-js/host`:

```jsonc
{
  "jsonrpc": "2.0",
  "method": "notifications/message",
  "params": {
    "id": "evt_…",                  // server-stamped
    "ts": "2026-05-17T00:00:00Z",   // server-stamped
    "type": "gateway.harness.child-spawned",
    "sourcePrincipal": { "kind": "system", "id": "gateway" },
    "correlationId": "…",
    "payload": { /* per-topic */ }
  }
}
```

Clients that want to act on specific topics should branch on
`params.type` and pull from `params.payload`.

## Gateway-side requirements

For the bridge to receive anything, the gateway must:

- Be running (the internal-gateway binary, an `agents-js serve`
  process with the bus mounted, or any other host that wires the
  `/events` subscribe handler).
- Expose the SSE `/events` endpoint on `$GATEWAY_BUS_URL` (the
  internal-gateway binary does this by default; trusted-network only).
- Be reachable from the MCP client process at spawn time.

The gateway requires at least one harness configured today — there is
no headless/gateway-only mode in v1. Bus events still publish even if
no client is subscribed; the bridge sees only events emitted after it
connects.

## Reconnect behavior

If the SSE stream drops (gateway restart, network blip), the bridge
reconnects with exponential backoff between
`GATEWAY_BUS_RECONNECT_MIN_MS` and `GATEWAY_BUS_RECONNECT_MAX_MS`.
Events emitted while disconnected are lost — the bus does not
replay. Clients that need durability should pair the bridge with
their own persistence layer.

## Architectural boundary

`@agents-js/host` ships the generic bus primitive and SSE subscribe
handler. This package depends on host one-way and adds the MCP
transport. Any future bridge (Slack, GitHub webhooks, Discord) gets
its own `extras/<sink>-bridge` package and reuses the same host
primitive without modifying this one.
