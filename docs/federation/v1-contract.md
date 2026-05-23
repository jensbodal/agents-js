---
title: Remote gateway federation — v1 contract
diataxis: reference
outline: [2, 3]
---

# Remote gateway federation — v1 contract

## What this covers

When a single agents-js gateway owns harnesses whose backing processes
run on a *different* host (or cluster) than the gateway itself, the
gateway becomes the *parent* in a federation and the host owning the
process becomes the *child*. This document is the canonical reference
for how the parent advertises those remote harnesses, how peers discover
them, and how dispatch flows from parent to child.

Audience: an external developer (or future agent) wiring a remote-backed
gateway against the v1 contract. Every type name and file path below
points at a real, exported symbol in this repository — there are no
aspirational placeholders.

## Three pieces

The v1 contract has three independent surfaces. A peer can adopt them
in any order; together they describe an end-to-end federation path.

### 1. Hostname-mode env discrimination

A federated gateway either advertises a resolvable hostname directly
(the default, back-compatible behavior) or runs in `null` hostname mode
and publishes itself through a coordinator. Two environment variables
gate this choice and are parsed by `resolveRemoteGatewayEnv`
(`packages/gateway-runtime/src/remote-gateway-env.ts`):

| Variable                       | Values                          | Notes                                              |
| ------------------------------ | ------------------------------- | -------------------------------------------------- |
| `AJS_GATEWAY_HOSTNAME_MODE`    | `"resolvable"` (default), `"null"` | Selects the discrimination mode.                |
| `AJS_GATEWAY_COORDINATOR_URL`  | `http(s)://...`                 | Required iff `HOSTNAME_MODE="null"`. http/https only. |

The parser fails loudly on any unknown mode value or an invalid URL —
silent degradation here would leave a gateway un-discoverable in
production.

Example — resolvable mode (default):

```bash
# No env vars needed; parser returns:
# { hostnameMode: "resolvable" }
```

Example — null mode (gateway behind NAT, registers via coordinator):

```bash
export AJS_GATEWAY_HOSTNAME_MODE=null
export AJS_GATEWAY_COORDINATOR_URL=https://coord.example.com
# Parser returns:
# { hostnameMode: "null", coordinatorUrl: "https://coord.example.com" }
```

The typed return shape is `RemoteGatewayEnvConfig`:

```ts
export interface RemoteGatewayEnvConfig {
  hostnameMode: "resolvable" | "null";
  /** Present iff hostnameMode === "null". */
  coordinatorUrl?: string;
}
```

### 2. Agent-card representation

Every entry in the gateway agent-card's `capabilities.harnesses` array
is a `HarnessCapabilityEntry` (`packages/a2a/src/discovery.ts`). v1
extends that type into a discriminated union on a new `source` field
so a single agent-card can mix locally-spawned and remote-backed
harnesses without ambiguity:

- `source: "local"` (or `source` omitted, for back-compat) — the parent
  gateway spawns the ACP child itself. No `remote` envelope.
- `source: "remote"` — a sibling `remote` envelope describes the child
  gateway that actually owns the process. Federation peers dispatch
  to that child instead of asking the parent to spawn.

The discriminated union gives compile-time guarantees: TypeScript
narrows `entry.remote` to defined whenever `entry.source === "remote"`,
and excludes it on the local branch.

Example payload — three entries from the same federated gateway:

```json
{
  "name": "team-gateway",
  "capabilities": {
    "harnesses": [
      {
        "id": "opencode",
        "displayName": "OpenCode ACP",
        "primary": true,
        "ready": true
      },
      {
        "id": "claude",
        "displayName": "Claude (remote, west cluster)",
        "primary": false,
        "ready": true,
        "source": "remote",
        "remote": {
          "gatewayUrl": "https://west.gateway.example.com",
          "hostnameMode": "resolvable",
          "childAgentId": "west-gateway"
        }
      },
      {
        "id": "gemini",
        "displayName": "Gemini (remote, null-hostname)",
        "primary": false,
        "ready": true,
        "source": "remote",
        "remote": {
          "gatewayUrl": "https://coord.example.com/g/gemini-eu-1",
          "hostnameMode": "null",
          "coordinatorUrl": "https://coord.example.com",
          "childAgentId": "gemini-eu-1"
        }
      }
    ]
  }
}
```

The first entry omits `source` — it is the back-compat shape every
single-host gateway emits today and is treated as `source: "local"`.
The second entry is a resolvable-remote: the child gateway has a
routable hostname and the parent dispatches directly to it. The third
entry is the null-hostname remote: the child is behind NAT and the
`remote.gatewayUrl` is a coordinator-rewritten URL that the coordinator
proxies onto the actual child process.

### 3. Parent → child wire shape (v1 decision)

The v1 wire-shape decision is: **HTTP A2A federation**, reusing the
existing `A2AAgentEntry` (`packages/a2a-client/src/registry.ts`,
`kind: "a2a"`) and `A2ATransport` primitives the rest of the gateway
already uses for outbound A2A calls. The parent gateway does not
invent a second federation protocol; it treats the child gateway like
any other remote A2A agent.

Flow for a single `message/stream` dispatch when an entry carries
`source: "remote"`:

1. Parent gateway receives an A2A `message/stream` request whose
   target harness resolves (via the operator-pinned primary or an
   explicit harness routing param) to an entry with `source: "remote"`.
2. Parent constructs an `A2AAgentEntry` from `entry.remote.gatewayUrl`
   (or via the coordinator when `hostnameMode === "null"`) and proxies
   the call to the child via the existing `A2AClient`/`A2ATransport`
   path.
3. Child gateway responds with the standard A2A surface: a JSON-RPC
   `message/stream` endpoint at `/a2a`, a `/events` SSE stream, and a
   `/.well-known/agent-card.json` discovery document.
4. Parent re-broadcasts the child's bus events onto its own
   `GatewayBus` under a namespaced topic so subscribers of the parent
   see federation traffic distinctly from local traffic:
   `gateway.federation.<childAgentId>.<originalTopic>`.

The actual `RemoteHarnessClient` glue that wraps `A2ATransport` and
emits the namespaced bus topics is **not** part of this PR — see
*Out of scope* below — but its public seam is defined: any future
implementation MUST consume the agent-card shape described in section 2
and the env contract from section 1 unchanged.

## Out of scope (v1)

Explicitly deferred to v2 or later, to keep the v1 contract reviewable
in isolation:

- `RemoteHarnessClient` — the runtime adapter that wraps `A2ATransport`
  and re-broadcasts child bus events under the
  `gateway.federation.<childAgentId>.*` topic prefix.
- `getRemoteLaneProxy` — the `HarnessLaneManager` routing branch that
  dispatches `source: "remote"` entries through the federation path
  instead of `getOrSpawnLane`. Today `getOrSpawnLane` only handles the
  local branch; the remote branch will land alongside
  `RemoteHarnessClient`.
- Coordinator integration — the wire shape between a gateway running in
  `hostnameMode === "null"` and the coordinator at
  `AJS_GATEWAY_COORDINATOR_URL` (registration, heartbeat, deregistration).
  v1 specifies that the env vars exist and that a `null`-mode gateway
  publishes itself through the coordinator; the actual registration
  protocol is its own contract.
- Cross-host auth — federation auth is tracked separately. The v1
  contract assumes a trusted network or pre-existing transport-level
  auth between parent and child. See
  [Federation peer-record signing & trust manifest](./peer-record-signing-and-trust-manifest.md)
  for the AJS-55 substrate that two federated gateways use to issue
  short-lived scoped JWTs to each other without sharing a long-lived
  admin token.
- Federated bus replay — the parent re-broadcast is best-effort and
  live-only. Late subscribers do not see historical child events.

## How a peer adopts this

A peer wiring itself as a child gateway (the host owning the actual
ACP process) follows three steps:

1. **Confirm reachability.** The parent must be able to reach the
   child at the advertised `remote.gatewayUrl`. When the child runs in
   `hostnameMode === "null"`, the coordinator is responsible for
   rewriting `gatewayUrl` to a coordinator-fronted URL that proxies
   onto the child — the parent does not need to know the child's true
   address.
2. **Expose the agent-card.** The child publishes its own agent-card
   at `/.well-known/agent-card.json`. The parent reads this card
   exactly as it would for any A2A agent and merges the child's
   advertised harnesses into its own `capabilities.harnesses` array
   with `source: "remote"` + a `remote` envelope pointing back at the
   child.
3. **Branch dispatch on `source`.** Routing logic inside the parent
   checks `entry.source === "remote"` and routes those dispatches
   through the federation path; entries without a `source` field (or
   with `source: "local"`) continue through the existing
   `HarnessLaneManager.getOrSpawnLane` local-spawn path.

For a parent that just wants to *consume* a federated peer's
agent-card, only step 3 applies: read the card from the peer's
`/.well-known/agent-card.json`, inspect each `capabilities.harnesses`
entry's `source` field, and dispatch accordingly.

## Reference implementations (when v2 lands)

v2 will add a federation-conformance harness at
`packages/a2a-client/src/federation-conformance.ts`. The shape mirrors
the `@agents-js/memory/testing` conformance pattern: a set of black-box
behavioural assertions any federation transport must satisfy
(agent-card discovery, `message/stream` proxying, bus re-broadcast
topic naming, error propagation on child crash). When that harness
ships, the test-shape itself becomes the contract reviewers point new
transport implementations at.

Until then, the source of truth for v1 is this document plus the three
typed surfaces it references:

- `resolveRemoteGatewayEnv` — `packages/gateway-runtime/src/remote-gateway-env.ts`
- `HarnessCapabilityEntry` (with `source` + `remote` envelope) —
  `packages/a2a/src/discovery.ts`
- `A2AAgentEntry` — `packages/a2a-client/src/registry.ts`
