---
title: Hosted MCP Tool Surface
diataxis: explanation
outline: [2, 3]
---

# Hosted MCP Tool Surface

This living design doc tracks the path from host-local Matrix MCP tools to an
agents-js-hosted MCP surface. It is intentionally current-state first: the
first smoke should use what already works, while the durable design moves the
tool surface behind agents-js provider abstractions.

<DocsArchitectureMap src="hosted-mcp-tool-surface.canvas" />

## Current State

`dot-matrix/mcp-server.py` is a stdio MCP server. A Codex or Claude client
starts it as a child process on the same host as the client. It reads Matrix
configuration from local `gopass` and sends with an explicit `as_agent`
parameter per tool call.

That shape is enough for the first olthoi0 smoke:

1. Provision `dot-matrix`, `python3`, and `gopass` on olthoi0.
2. Add a Codex MCP server entry that launches `mcp-server.py` over stdio.
3. Call `send_message` with `as_agent: "codex-hostname-null"`.
4. Read context with `get_messages`.
5. Let the running Matrix bridge observe the room event and route mentions.

This is a provisioning pattern, not a hosted product surface.

## Target Shape

The durable target is an agents-js-hosted MCP server that exposes
identity-aware tools such as `SendMessage` and `FetchContext` to any harness.
The harness should not need to know whether Matrix is backed by `dot-matrix`,
an HTTP proxy, a bus subscriber, or a future service.

The boundary is provider-shaped:

- `MatrixToolProvider` owns room send/read semantics.
- `ContextProvider` or the existing `fetchContext` primitive owns grounded
  context recall.
- `MetricsProvider` owns harness-neutral telemetry.
- Identity binding comes from host bootstrap and federation trust work, not
  from wrapper-launching every harness through agents-js.

## Source-Backed Anchors

- `packages/mcp-bridge/src/index.ts` already defines the MCP bridge package as
  the surface that exposes agents as MCP tools.
- `packages/tools/src/index.ts` already exports `fetchContext` and tool
  registry primitives.
- `extras/matrix-bridge/src/index.ts` already keeps Matrix-specific bridge
  event shaping outside the generic host package.
- `dot-matrix/mcp-server.py` is the current working Matrix MCP backend, but it
  is stdio-only and repo-local.

## Deployment Patterns

| Pattern | Shape | When It Wins |
| --- | --- | --- |
| Provision everywhere | Each host has `dot-matrix` plus local credentials. | First one to three hosts and immediate smoke tests. |
| Remote MCP proxy | One canonical host exposes Matrix tools over authenticated network MCP. | When provisioning drift costs more than proxy risk. |
| agents-js host bootstrap | agents-js provisions host identity, MCP config, and provider-backed tools. | Production multi-host operation. |

The current recommendation is to ship the first smoke with provision-everywhere
and track the hosted MCP surface as the product path.

## Open Work

- Define the `MatrixToolProvider` interface and identity binding contract.
- Decide whether the first provider wraps `dot-matrix/mcp-server.py` as a
  subprocess or calls a narrower Python/HTTP adapter.
- Add hosted MCP tools for `SendMessage` and `FetchContext`.
- Document the host-bootstrap path that installs the MCP config without
  requiring every harness to be launched through agents-js.
- Keep metrics as a provider concern so harness-native telemetry can be
  consumed without duplicating work in agents-js.

