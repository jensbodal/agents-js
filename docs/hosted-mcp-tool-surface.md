---
title: Hosted MCP Tool Surface
diataxis: explanation
outline: [2, 3]
---

# Hosted MCP Tool Surface

This living design doc tracks the path from host-local Matrix MCP tools to an
agents-js-hosted MCP surface. It is intentionally current-state first: the
first smoke should use what already works, while the durable design moves the
tool surface behind agents-js provider abstractions and the AJS-57 runtime
session protocol.

<DocsArchitectureMap src="hosted-mcp-tool-surface.canvas" />

## Current State

`dot-matrix/mcp-server.py` is a stdio MCP server. A Codex or Claude client
starts it as a child process on the same host as the client. It reads Matrix
configuration from local `gopass` and sends with an explicit `as_agent`
parameter per tool call.

That shape is enough for the first olthoi0 smoke:

1. Provision `dot-matrix`, `python3`, and `gopass` on olthoi0.
2. Add a Codex MCP server entry that launches `mcp-server.py` over stdio.
3. Call `send_message` with `as_agent: "olthoi0-codex-app"`.
4. Read context with `get_messages`.
5. Let the running Matrix bridge observe the room event and route mentions.

This is a provisioning pattern, not a hosted product surface.

## Target Shape

The durable target is an agents-js-hosted MCP server that exposes
identity-aware tools such as `agents.send_message`, `agents.get_messages`,
`matrix.send_message`, and `fetch_context` to any harness.
The harness should not need to know whether Matrix is backed by `dot-matrix`,
an HTTP proxy, a bus subscriber, or a future service.

The boundary is provider-shaped:

- The MCP dispatch layer owns target routing for canonical tools such as
  `agents.send_message`. It is not a Provider itself.
- `MatrixToolProvider` owns room send/read semantics.
- `AgentInboxProvider` owns local agent-mailbox delivery as the explicit
  fallback substrate for known agents without Matrix routing.
- `ContextProvider` or the existing `fetchContext` primitive owns grounded
  context recall.
- `MetricsProvider` owns harness-neutral telemetry.
- Identity binding comes from host bootstrap, AJS-55 federation trust, and the
  AJS-57 runtime session protocol, not from wrapper-launching every harness
  through agents-js.

The runtime contract is:

- AJS-55 signs long-lived peer records and bootstrap trust material.
- AJS-57 mints short-lived JOSE/JWT sessions after a signed challenge.
- Hosted MCP tools verify `Authorization: Bearer <JWT>` before provider
  dispatch.
- JWT `scopes` map one-to-one with MCP tool names such as
  `agents.send_message`, `matrix.send_message`, or `inbox.deliver`.
- Matrix identity is server-resolved from the verified `sourcePrincipal`;
  clients never pass `as_agent`, Matrix tokens, or senders as tool arguments.

The router has two independent gates:

1. Caller scope must authorize the requested delivery action.
2. Target capability must resolve to a substrate.

If the caller lacks Matrix scope, hosted MCP must not silently send as a
fallback Matrix identity. If the target is a known agent without Matrix routing,
the router can deliver to the explicit inbox substrate. If the target is
unknown, it returns a structured error and records the failed route.

## Delivery Router

The canonical user-facing tool is `agents.send_message(target, body, ...)`.
Provider-direct tools remain available for diagnostics or explicit routing, but
they do not own the target-routing policy.

```text
agents.send_message(target, body, ...)
  -> verify AJS-57 JWT and caller scopes
  -> resolve target capabilities from AJS-55 trust + gateway registry
  -> route:
       target has Matrix routing      -> MatrixToolProvider
       known agent without Matrix     -> AgentInboxProvider
       unknown target                 -> structured error / DLQ
  -> emit audit event with source, target, substrate, and correlationId
```

| Surface | Owner | Backend |
| --- | --- | --- |
| `agents.send_message` / `agents.get_messages` | MCP dispatch router | Target capability resolver plus providers |
| `matrix.send_message` / `matrix.get_messages` | `MatrixToolProvider` | Narrow dot-matrix adapter subprocess |
| `inbox.deliver` / `inbox.read` | `AgentInboxProvider` | `agent-msg` SQLite mailbox |

## Source-Backed Anchors

- `packages/mcp-bridge/src/index.ts` already defines the MCP bridge package as
  the surface that exposes agents as MCP tools.
- `packages/tools/src/index.ts` already exports `fetchContext` and tool
  registry primitives.
- `extras/matrix-bridge/src/index.ts` already keeps Matrix-specific bridge
  event shaping outside the generic host package.
- `dot-cognee/agent-msg/src/db.ts` already implements the SQLite mailbox used
  by local agent-to-agent delivery; its default store is
  `data/agent-msg/agent-msg.db` under the user's `dot-cognee` workspace unless
  `AGENT_MSG_DB` is set.
- `dot-matrix/mcp-server.py` is the current working Matrix MCP backend, but it
  is stdio-only and repo-local.
- The hosted provider backend starts as a narrow Python adapter subprocess that
  reuses dot-matrix Matrix-client and gopass helpers. It does not verbatim-wrap
  `mcp-server.py`, because that alpha entrypoint exposes admin-oriented tools
  and accepts client-supplied `as_agent`.

## Deployment Patterns

| Pattern | Shape | When It Wins |
| --- | --- | --- |
| Provision everywhere | Each host has `dot-matrix` plus local credentials. | First one to three hosts and immediate smoke tests. |
| Remote MCP proxy | One canonical host exposes Matrix tools over authenticated network MCP. | When provisioning drift costs more than proxy risk. |
| agents-js host bootstrap | agents-js provisions host identity, MCP config, and provider-backed tools. | Production multi-host operation. |

The current recommendation is to ship the first smoke with provision-everywhere
and track the hosted MCP surface as the product path.

## Sequencing

AJS-56 is not the next implementation step by itself. It depends on three
substrates:

- AJS-54 1a: registry sync from gateway so hosts can discover current peers.
- AJS-55: signed federation peer records for bootstrap/static trust.
- AJS-57: runtime session protocol for short-lived JWT verification,
  key-rotation, denylist, and lease semantics.

Until those land, the in-repo page is a design surface, not an implementation
promise.

## Open Work

- Define the MCP delivery-router interface, `MatrixToolProvider` interface, and
  identity binding contract.
- Implement the narrow dot-matrix adapter subprocess for the first backend.
- Add hosted MCP tools for canonical `agents.send_message` routing plus
  provider-direct `matrix.send_message`, `matrix.get_messages`, and
  `fetch_context` using the `<provider>.<method>` naming convention.
- File and implement the fast-follow `AgentInboxProvider` ticket for
  `inbox.deliver` and `inbox.read`.
- Exclude admin-oriented dot-matrix tools such as `set_lead`, `invite_agent`,
  and `poller_status` from the general `MatrixToolProvider` surface.
- Document the host-bootstrap path that installs the MCP config without
  requiring every harness to be launched through agents-js.
- Keep metrics as a provider concern so harness-native telemetry can be
  consumed without duplicating work in agents-js.
