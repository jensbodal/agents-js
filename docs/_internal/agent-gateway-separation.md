# Agent-gateway separation

**Status**: ANCHOR — short reference doc for the decoupled-gateway program.
Captures current state, target state, and the host/gateway/runtime
boundary. Does not block AJS-8 or DOT-393.

## Current state

`agents-js serve` resolves one runtime/harness selection at startup and
binds it into the serve process for that process's lifetime. The
gateway, host, and runtime concerns ride in one Bun process:

- One A2A HTTP server (`apps/internal-gateway/main.ts:510`)
- One WS bridge on a separate port (`apps/internal-gateway/main.ts:535`)
- One permission engine + store, one audit emitter, one surface
  broadcaster, one AG-UI coordinator, one agent card
- One primary harness child process (`ACPSessionController`) + N lane
  harness children (one per A2A `contextId`, all same-binary today —
  `apps/internal-gateway/main.ts:480-495`)
- `@@dispatch` to ACP-kind registry entries spawns an additional
  ephemeral harness child per call (`packages/host/src/host-executor.ts:872-969`)

So the existing topology is already `1 gateway → N harness children`.
The constraint today is that those children must all be the *same*
harness binary; the fan-out machinery itself is in code.

## Target state

- **Gateway runs as a long-lived service** with no specific harness
  baked in at startup.
- **Agents (harness processes) connect to the gateway**, not the other
  way around. Multiple harness types can be connected concurrently.
- **Session-level harness selection at session creation only.** Session
  is bound to a harness for its lifetime; switching mid-session means
  forking the conversation context, which is not free and is treated as
  a separate-new-session operation.
- **Agent card surfaces the fleet.** A2A consumers federate to the
  gateway as another A2A peer and see the available harnesses via the
  card's `capabilities.harnesses` extension (AJS-7).
- **One permission store, one audit, one WS bridge, one agent card per
  machine.** State coherence is the load-bearing reason to consolidate.

## Boundary

```
  ┌──────────────────────────────────────────────────────────────┐
  │  HOST                                                        │
  │  UX, policy, prompts, permissions                            │
  │                                                              │
  │  - browser app / CLI client                                  │
  │  - permission-rules.json + permission engine                 │
  │  - prompt templates, system-prompt composition               │
  │  - workspace policy, trust mode                              │
  └─────────────────────┬────────────────────────────────────────┘
                        │
  ┌─────────────────────▼────────────────────────────────────────┐
  │  GATEWAY                                                     │
  │  Protocol translation                                        │
  │                                                              │
  │  - A2A HTTP server (native wire format)                      │
  │  - WS bridge for browser clients                             │
  │  - AG-UI coordinator                                         │
  │  - Push channel / event bus + SSE transport (AJS-8)          │
  │  - Agent-card discovery surface                              │
  │  - Routing: session → harness child                          │
  └─────────────────────┬────────────────────────────────────────┘

  (MCP transport bridging is NOT a gateway responsibility. It lives
   in a separate consumer service that subscribes to the gateway's
   SSE channel and re-emits as MCP server-initiated notifications.
   Tracked as AJS-9.)
                        │
  ┌─────────────────────▼────────────────────────────────────────┐
  │  RUNTIME                                                     │
  │  Execution                                                   │
  │                                                              │
  │  - Harness child processes (claude-agent-acp, codex-acp,     │
  │    gemini-cli, opencode, pi-acp, ...)                        │
  │  - LLM context, tool execution, model conversation state     │
  │  - ACP wire (JSON-RPC over stdio)                            │
  └──────────────────────────────────────────────────────────────┘
```

**Host** owns UX, policy, prompts, permissions — the user-facing surface
and the rules about what's allowed.

**Gateway** owns protocol translation — converting between A2A (native),
WS (browser), and the internal event bus / SSE push channel. Holds
session state insofar as it tracks `sessionId → harness child`
mappings. MCP transport bridging is NOT in the gateway; it lives as a
separate consumer service (AJS-9) that subscribes to the gateway's SSE
channel.

**Runtime** owns execution — the harness child process running the
actual LLM agent. Conversation state and tool execution live inside the
harness subprocess (ACP contract — harnesses are always subprocesses).

## Active-ticket implications

- **AJS-7** (multi-harness ordering): gateway-layer routing decision.
  Lives at the host↔gateway and gateway↔runtime boundary lines. Parked
  pending DOT-393 first smoke.
- **AJS-8** (push channel): gateway-layer event bus + SSE transport.
  A2A-native wire format. MCP transport bridging is explicitly out of
  scope for AJS-8 and lives in AJS-9 as a separate consumer service.
- **DOT-392** (identity model): cross-cutting; ties to which layer
  carries the principal. Phase 1 = types-only shared vocabulary; later
  phases will pin identity to specific layer (likely runtime per the
  Model 2 framing — each harness child carries its own principal).
- **DOT-393** (first usable remote-agent path): exercises the boundary
  in production. Same-LXC smoke first (gateway + gemini-cli on one
  LXC); cross-LXC federation follow-up.

## Non-goals (for this anchor doc)

- Does not pick implementation order for AJS-7 / AJS-8 (those are
  decided in their own tickets).
- Does not specify the bus wire format in detail (AJS-8's job).
- Does not specify identity types (DOT-392's job).
- Does not specify the host's frontend architecture (separate concern).

— may-11
