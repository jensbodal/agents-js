---
title: Streaming, Events, and Concurrency
diataxis: explanation
---

# Streaming, Events, and Concurrency

> **Status:** Beta · **Validated by:** `message/send`, `message/stream`, `tasks/get`, `tasks/resubscribe` package tests + `gateway-e2e` + `host-executor.test.ts` + `agui-endpoint.test.ts` · **Known limitations:** incremental `TaskArtifactUpdateEvent` append parity, ACP URL-mode elicitation, AG-UI run resumption, A2UI user→agent back-channel contract (see [Deliberate limits](#deliberate-limits))

This page documents three related runtime contracts:

1. **Streaming** — the wire-level guarantees on task-backed SSE (`message/stream`, `tasks/resubscribe`).
2. **Events** — the normalized event vocabularies that flow across the ACP bridge, A2A gateway, and clients.
3. **Concurrency and session model** — how the gateway isolates sessions across the five distinct request paths.

## Status

Implemented for the beta release track.

This document is the normative technical contract for what `agents-js` currently supports across
the A2A gateway, client, CLI, and ACP bridge. It replaces the earlier investigation-only posture.
The Browser and CLI guides describe how those capabilities show up in the reference user surfaces.

## Current support

### Gateway and transport

- `message/send` remains supported for non-streaming clients.
- `message/stream` is supported and served as `text/event-stream`.
- `tasks/get` remains supported for streamed and non-streamed tasks.
- `tasks/resubscribe` is supported through the gateway and client stack.
- Discovery advertises `capabilities.streaming = true`.

### Event model

- The gateway streams task-backed updates, not raw ACP chunks.
- Supported streamed event shapes:
  - `Task` snapshots
  - `TaskStatusUpdateEvent`
- Current streamed status coverage:
  - `submitted`
  - `working`
  - `input-required`
  - `auth-required`
  - terminal task states such as `completed`, `failed`, `canceled`, `rejected`, and `unknown`
- Incremental text is carried through `status.message` updates and consumed incrementally by the
  client and CLI.

### Client and CLI

- `@agents-js/a2a-client` prefers `message/stream` when the target advertises streaming, unless the
  caller disables streaming explicitly.
- The client can resume an in-flight or persisted task with `tasks/resubscribe`.
- The CLI is the reference live-task UX for the release track.
- The CLI shows:
  - streaming capability
  - current task id
  - resumable task state
  - pending streamed text
  - elicitation metadata
  - auth-required state

### ACP bridge

- ACP `agent_message_chunk` updates are translated into streamed A2A working-state updates.
- ACP form-mode elicitation is translated into A2A `input-required` task state plus ACP-scoped
  metadata.
- ACP authentication-required conditions are translated into A2A `auth-required` task state plus
  ACP-scoped metadata.
- Continuations from the A2A side are mapped back into the same ACP turn via task/message
  metadata.

## Deliberate limits

The current release track does **not** claim the following on the streaming-events
contract specifically. (For overall AG-UI / A2UI implementation status, see
[Protocols → AG-UI](/protocols#ag-ui) and [Protocols → A2UI](/protocols#a2ui) —
both ship as first-class wire protocols, but the items below are explicit gaps
in the streaming layer:)

- incremental `TaskArtifactUpdateEvent` append parity
- ACP URL-mode elicitation
- parity with every custom host's local elicitation UX
- shared upstream renderer implementations
- AG-UI run resumption or per-thread state retention across reconnects
- a stable user → agent A2UI back-channel contract (the surface event currently
  rides a namespaced `agents-js.a2ui.surface_event` `CUSTOM` event until the
  upstream A2UI spec standardizes the path — see [Protocols → A2UI](/protocols#a2ui))

## Contract details

### `message/send`

- Returns the existing non-streaming JSON-RPC result path.
- Should remain safe for older or simpler clients.
- Must not require streaming support from the caller.

### `message/stream`

- Returns SSE with `data: <json>` frames.
- Each frame contains a valid JSON-RPC response envelope whose `result` is an A2A stream event.
- The gateway may emit:
  - an initial submitted `Task`
  - one or more working `TaskStatusUpdateEvent` frames
  - a final `Task`

### `tasks/resubscribe`

- Uses the same SSE framing as `message/stream`.
- Reconnects the caller to task-backed streamed state instead of forcing a new prompt turn.
- Current support is oriented around task continuity for the reference client and CLI flows.

## ACP mapping

!!!include(_generated/acp-session-mapping.md)!!!

`ACPSessionController` translates each of the variants above into host-side
events and A2A status updates per the rules below.

### ACP text chunks

- ACP `agent_message_chunk` text updates are accumulated per active task.
- The executor emits these as A2A working-state status updates with a task-scoped agent message.
- The first valid ACP chunk `messageId` is preserved when available.
- If no valid ACP chunk `messageId` is ever observed, the gateway falls back to a generated UUID at
  finalization time.

### ACP elicitation

- Only form-mode is in scope for the initial release track.
- The ACP controller exposes an explicit elicitation adapter surface.
- The A2A bridge maps elicitation to:
  - task state `input-required`
  - ACP-scoped metadata for structured form schema
  - resumable task identity so the caller can continue the same turn

### ACP auth-required

- Auth-required conditions are surfaced as live task state, not hidden internal errors.
- The bridge attaches ACP-scoped auth metadata so the client can present available methods.
- The reference client and CLI respond by sending continuation metadata back through the same task.

### Artifact updates

- `task.artifact.updated` remains part of the client event model, but incremental append semantics
  are not part of the current release claim.
- Current session reduction only preserves task/context identity when an artifact update event
  arrives; it does not accumulate artifact parts or infer append or `lastChunk` semantics.
- Reopening artifact-append work requires:
  - explicit executor mapping from ACP updates into artifact sources
  - a defensible append or `lastChunk` boundary rule, or new signaling where derivation is not safe
  - client-side artifact accumulation semantics once artifact payloads are reduced into session state

## Remaining gaps

These are still open even though streaming is now enabled:

- incremental artifact append semantics
- explicit disconnect-driven cancellation coverage
- richer replay semantics for abandoned long-running tasks
- broader compatibility testing against third-party A2A clients

## Validation

The following are currently covered by tests in this branch:

- gateway E2E for `message/send`
- gateway E2E for `message/stream`
- gateway E2E for `tasks/resubscribe`
- a2a-client integration using the streamed gateway path
- executor tests for first-valid ACP chunk `messageId` handling
- ACP controller tests for elicitation capability advertisement and runtime dispatch

## Release posture

For the initial release track, the streaming claim is:

- task-backed streaming text
- streamed task-state transitions
- resumable task identity
- `tasks/resubscribe`
- CLI reference UX for live streaming, form elicitation, and auth-required continuation

Artifact-append parity remains intentionally outside that claim.


---


## The five paths at a glance

<!-- pending-extraction: streaming-five-paths -->

| Path | Endpoint | Session isolation | In-flight slots | Streaming | Notes |
|---|---|---|---|---|---|
| **A2A** (`message/send`, `message/stream`, `tasks/resubscribe`) | `POST /a2a` | **Per `contextId`** — disjoint `SessionLane` per context | One in-flight prompt per lane (per-lane mutex) | Yes (SSE on `message/stream` / `tasks/resubscribe`) | Each lane gets its own controller when a `controllerFactory` is configured; otherwise lanes share a primary controller. |
| **AG-UI** (native transport) | `POST /agent` | **None today** — single shared `controller` | Single in-flight run for the gateway process | Yes (SSE: `RUN_STARTED` → events → `RUN_FINISHED` / `RUN_ERROR`) | No per-`threadId` lane separation. Concurrent AG-UI runs serialize on the shared host session. |
| **Browser WS bridge** | `ws://…/ws` | Bridge-scoped session | Bridge-scoped | Yes (forwarded events) | Lifecycle is owned by the WS bridge; surface events ride a namespaced `agents-js.a2ui.surface_event` `CUSTOM` event. |
| **mention path** (delegated dispatch via mention middleware) | A2A submission containing a recognized mention token | N/A — middleware delegates outbound | Blocking until target completes | **No** — `stream: false, blocking: true` (`packages/a2a-client/src/middleware.ts:334-338`) | Synchronous handoff. Caller does not see incremental updates from the target. |
| **dispatch directive** (deterministic A2A routing) | A2A submission with a parsed dispatch directive | Routed to target executor; current lane is bypassed | Target-side concurrency | Yes — target's native streaming applies | `host-executor.ts:259-263` parses the directive before lane resolution; routing is deterministic, not blocking-by-default. |

## Path-by-path detail

### A2A — per-`contextId` session lanes

`HostA2AExecutor` (`apps/internal-gateway/host-executor.ts`) maintains a
`Map<contextId, SessionLane>`. The lane is the unit of concurrency:

- Two requests on the **same** `contextId` share the lane and serialize on
  `lane.inFlightPrompt`. The second caller waits for the first to complete.
- Two requests on **different** `contextId`s get disjoint lanes and execute in parallel.
- When the executor is configured with a `controllerFactory`, each lane spawns its own
  `GatewayHostController` (and destroys it on lane teardown). Without a factory, lanes
  share the primary controller.

The lane carries a per-lane single-slot mutex, the controller subscription handle, and a
`lastActivityMs` timestamp used by the idle sweep.

### AG-UI — single shared host session (today)

The AG-UI endpoint (`apps/internal-gateway/agui-endpoint.ts`) accepts a single
`controller` at construction time and uses it directly for every run. There is no
per-`threadId` map. Concurrent `POST /agent` requests will run sequentially against the
same host session.

This is a deliberate scope choice for the current release track. The audit specifically
calls out:

- no resume across reconnects
- no per-thread state retention

If you need parallel sessions, drive A2A. If you need resumption, the path is
`tasks/resubscribe` on the A2A side, not AG-UI.

### Browser WS bridge

The WS bridge handles its own session lifecycle inside the browser. A2UI surface events
flow through the bridge as namespaced `agents-js.a2ui.surface_event` `CUSTOM` events
(an explicit gap until the upstream A2UI spec standardizes the user → agent
back-channel; tracked in `docs/streaming-and-events.md` deliberate-limits).

### mention path — blocking, non-streaming

The mention middleware (`packages/a2a-client/src/middleware.ts`) intercepts mention
tokens and delegates to the target via `provider.sendTurn(...)` with
`stream: false, blocking: true`. The caller's turn does not return until the target
completes. This is intentional — mention dispatch is currently treated as a synchronous
handoff and has no streaming variant in the current release track.

### dispatch directive — deterministic A2A routing

When the executor receives a prompt whose first line parses as a dispatch directive
(see `parseDispatchDirective`), `host-executor.ts:259-263` routes it through the
direct-dispatch path **before** lane resolution. Streaming on the dispatch path is
governed by the target executor — the gateway forwards what the target emits.

## Concurrency boundary summary

<!-- pending-extraction: concurrency-boundary -->

| Concurrency aspect | Bounded by | Where enforced |
|---|---|---|
| Same-context serialization | `lane.inFlightPrompt` | `host-executor.ts` `getOrCreateLane()` + `runPrompt()` |
| Cross-context parallelism | Number of distinct `contextId`s | Lane map size; lane idle sweep evicts stale entries |
| AG-UI parallelism | Single active run | `AguiRunCoordinator` rejects overlapping `/agent` runs with HTTP 409 before SSE opens |
| Mention dispatch | Caller-blocking | `middleware.ts` `sendTurn(..., { stream: false, blocking: true })` |
| Cancellation | Task-level cancel + ACP session cancel; AG-UI disconnect calls controller cancel and emits a terminal run error | A2A executor + ACP host adapter + AG-UI run session |

## What this page does NOT cover

- Per-runtime concurrency inside a single lane (e.g., whether `claude-agent-acp` itself
  serializes its own ACP turns) — that's a runtime concern, not a gateway concern.
- WebSocket bridge implementation details — see the surfaces guide.
- A2UI back-channel contract — currently rides namespaced `CUSTOM` events; tracked as a
  deliberate limit in [Streaming and Events](/streaming-and-events#deliberate-limits)
  and the Protocols A2UI section.

## Related

- [Protocols → A2A](/protocols#a2a) — wire-level A2A reference
- [Protocols → AG-UI](/protocols#ag-ui) — AG-UI native transport
- [Streaming and Events](/streaming-and-events) — wire-level streaming guarantees +
  deliberate limits
- [Surfaces](/surfaces) — host-adapter and renderer architecture
