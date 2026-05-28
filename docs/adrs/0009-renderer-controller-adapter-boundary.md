# ADR 0009 — Renderer-controller adapter boundary

**Status**: Proposed (2026-05-27) — in-0.6.0 scope per Jens 2026-05-28 directive
**Deciders**: cognee-claude (architecture-lead, ADR draft), cognee-codex (source-checked review)
**Affects**: `@agents-js/a2ui-host`, `@agents-js/a2ui-renderer`, `@agents-js/host`, `@agents-js/canvas-model`, prospective host-side renderer adapter package

---

## Context

The agents-js stack already separates host lifecycle from rendering. Source-checked observations (per cognee-codex 2026-05-27 matrix event `$J9SqbnjQNec3HmpLIoXlL5lyesd67qr8JNNkUTqs0nY`):

- `packages/a2ui-host/src/host.ts` owns validation, A2UI message processing, coalesced render scheduling, and destroy/cleanup lifecycle.
- `packages/a2ui-host/src/host.ts` injects a `SurfaceRenderer`, so the host layer is renderer-agnostic today.
- `packages/a2ui-renderer/src/surface-view.ts` is intentionally snapshot-to-Lit-template rendering. It is not the correct place for high-frequency WebGL/WebGPU/WASM frame loops.
- `docs/streaming-and-events.md` treats A2A `tasks/resubscribe` as the durable resumable stream path. AG-UI run resumption and A2UI user-to-agent back-channel are documented gaps.
- `packages/canvas-model/src/index.ts` already supports durable canvas artifacts: A2UI payload preservation, lossy JSON Canvas preview export, OCIF-style preservation.

This ADR formalizes the **renderer-controller adapter boundary** between:
- Protocol-tier surfaces (ACP, A2A, JSON-RPC envelope) — audited, ordered, durable
- Scene-intent / lifecycle / control-plane events (AG-UI, A2UI) — semantic-frequency, audited
- High-frequency rendering (WebGL/WebGPU/WASM/SAB/Atomics, frame pacing, binary pixel transport) — host/runtime-internal, performance-tier, NOT protocol-bound

The boundary is the load-bearing decision for 0.6.0 release-shape: shipping without it risks hardening the wrong abstraction model.

## Why in-0.6.0 scope (per Jens 2026-05-28 directive)

Originally framed as post-0.6.0 architecture-exploration. Jens's matrix event `$K_PdLAa_Yp8viGucEbfcb6uVS-EDnIlVKom7HLhGzDo` re-classified to in-0.6.0 under the convergence-mode "necessary for release correctness" exception. Reasoning: shipping 0.6.0 with renderer surfaces ambiguous about where the boundary sits would lock in the wrong model when external consumers integrate.

Constrained scope keeps the work freeze-compatible (~500-800 LOC across ADR + types + one prototype, comparable to existing in-flight wake-family work).

## Decision

### Renderer-controller boundary (canonical layer map)

```
+--------------------------------------------------------------+
|  ACP / A2A / JSON-RPC envelope                               | renderer-agnostic
|  - audited, ordered, durable                                 | (rule 6: gateway = transport translation)
|  - tasks/resubscribe for durable streams                     |
+--------------------------------------------------------------+
|  AG-UI / A2UI                                                | scene-intent + lifecycle
|  - declarative payloads                                      | (semantic-frequency, audited)
|  - semantic updates                                          |
|  - lifecycle / control-plane events                          |
|  - durable artifacts (JSON Canvas, OCIF-style preserved)     |
+--------------------------------------------------------------+
|  Host-side renderer-controller adapter                       | high-frequency local rendering
|  - SurfaceRenderer interface (already injected by a2ui-host) | (perf-tier, NOT protocol-bound)
|  - mount/init/apply/resize/capture/stats/dispose lifecycle   |
|  - WebGL / WebGPU / WASM / SAB / Atomics adapter-internal    |
|  - frame pacing, binary pixel transport                      |
+--------------------------------------------------------------+
```

### Formal host-side renderer adapter lifecycle

The `SurfaceRenderer` interface (currently injected into `a2ui-host`) is formalized with a lifecycle protocol:

- `mount(target)` / `init()` — attach to a DOM/canvas/worker target, allocate resources
- `apply(update)` / `update(snapshot)` — apply scene-intent or semantic update from A2UI
- `resize(dims)` — handle viewport/canvas resize
- `capture(opts)` — emit a durable artifact (PNG, JSON Canvas, scene snapshot)
- `stats()` — return joinable observability metadata (frame counters, render budget, surface ID)
- `dispose()` — release resources, detach from target

The interface is host-side, NOT exposed as remote protocol in 0.6.0. Standardization is local; remote-protocol exposure is a post-0.6.0 question once a host-local prototype validates the surface doesn't distort A2A/ACP semantics.

### Three-tier renderer-state model

1. **Declarative payloads** (above-protocol): A2UI/AG-UI scene intent, durable snapshots, semantic state. One-shot or low-freq. Audited.
2. **Streamed operational updates** (above-protocol): ordered task/session events, low-frequency semantic updates. Audited.
3. **Binary / shared-memory rendering** (below-protocol): local-only renderer tier, 60-120Hz frame loop, lossy/performance-oriented, outside protocol durability guarantees.

### JSON Canvas as initial durable export surface

`@agents-js/canvas-model` already provides JSON Canvas export + OCIF-style preservation. Use as the initial durable artifact format. Live rendering uses separate runtime model.

### SharedArrayBuffer + Atomics — adapter-internal optimization

SAB+Atomics is an implementation optimization behind the renderer adapter. Never appears in ACP, A2A, AG-UI, A2UI, or JSON-RPC contracts. Hosts that choose to use SAB for renderer-to-worker IPC do so as a local optimization; the protocol layer is unaware.

### Observability via joinable metadata

Renderer traces and stats join the existing observability chain through metadata: `sessionId`, `requestId`, task ID, surface ID. `docs/streaming-and-events.md` notes that end-to-end correlation is not fully threaded yet, so this is framed as **metadata-joinable** first, not a claim of complete tracing coverage.

### Resumability — conditional

- Task-backed renderer streams (renderer driven by A2A task producing UI updates): use existing `tasks/resubscribe` semantics, renderer attaches to task's resumption story.
- Pure-local frame loops (always-on dashboard, ambient visualization): renderer lifecycle recovery semantics (re-mount on reconnect, replay last snapshot). Do NOT force A2A resubscribe onto high-frequency local rendering.

### Execution location — host-local or browser worker (0.6.0 first slice)

- Host-local: in the host process (Node, Bun, browser main thread). Tightest integration, no IPC overhead.
- Browser worker: off-main-thread, isolated, SAB-accessible. The right choice when frame budget matters.
- Remote A2A streaming: NOT in 0.6.0. Latency breaks 60Hz frame loops. Post-0.6.0 question.

## Explicit non-goals (0.6.0 first slice)

- **No remote frame transport.** Frame data never crosses the protocol envelope.
- **No ACP/A2A envelope mutation.** Protocol contracts stay renderer-agnostic.
- **No renderer-specific protocol.** No new wire shape for rendering.
- **No WebGPU requirement.** Renderer adapters can use any backend; WebGPU is one option not a mandate.
- **No standardized remote renderer tool contract.** Local-only interface in this slice; remote standardization is post-0.6.0 if proven local-first.
- **No 60-120Hz frame state streamed through AG-UI/A2UI.** Frame loops stay below the protocol line.

## 0.6.0 scope (constrained)

1. **This ADR** — captures renderer-controller boundary decisions.
2. **Formal host-side renderer adapter lifecycle interface** — types + interface for mount/init/apply/resize/capture/stats/dispose. Additive to existing `SurfaceRenderer` injection point.
3. **One host-local prototype** — single-backend (Canvas2D recommended for first slice; WebGL optional) renderer adapter proving:
   - Existing host/runtime seams can drive renderer updates without protocol changes
   - Renderer can emit JSON Canvas durable artifacts via the `capture()` method
   - Trace/session/task metadata attaches cleanly via `stats()` joinable surface

## Post-0.6.0 deferred questions

- Remote frame transport (if/when needed)
- WebGPU-specific renderer adapter
- Multi-renderer composition (multiple adapters in one host)
- Streamed binary updates across A2A (likely never; would violate the boundary)
- Remote standardized renderer tool contract (after local-first proves out)
- Cross-host renderer state synchronization (requires consensus protocol, separate ADR)

## Cross-references

- **6 hard rules** (Jens 2026-05-27 direction-set event `$29JyIKoyBfOw5zj15vsQSmfs49I6FRX1_EOW5SK7UQ4`): rule 6 — AG-UI/A2UI above transport/runtime
- **ADR-0007**: wake-trigger gateway substrate (separate post-0.6.0 work)
- **ADR-0008**: SubscribedResponseWakeAdapter shape-vs-variant (separate post-0.6.0 work)
- **ADR-0006**: canvas spatial runtime (hostname-null-claude-0 lane, pending; this ADR coordinates with that work)
- **Jens 2026-05-28 renderer directive**: matrix event `$K_PdLAa_Yp8viGucEbfcb6uVS-EDnIlVKom7HLhGzDo`
- **cognee-codex source-checked review**: matrix event `$J9SqbnjQNec3HmpLIoXlL5lyesd67qr8JNNkUTqs0nY`
- **cognee-claude / cognee-codex convergence**: matrix event `$igp8MBcdcBUU6OM2-Jd_zdkk9eX6Y-A1Ngu9OHyM4H0`
- **Existing substrate** (cognee-codex source-checks):
  - `packages/a2ui-host/src/host.ts` — host/renderer split, SurfaceRenderer injection
  - `packages/a2ui-renderer/src/surface-view.ts` — snapshot-to-Lit-template (not high-freq renderer site)
  - `packages/canvas-model/src/index.ts` — JSON Canvas + OCIF-style artifact substrate
  - `docs/streaming-and-events.md` — tasks/resubscribe + observability gap framing

## Sequencing (after this ADR merges)

1. **Adapter lifecycle types PR** (small, additive) — types + interface for the 7-method lifecycle. ajs-claude or cognee-codex implementer.
2. **Host-local prototype PR** (medium, single backend) — Canvas2D adapter implementing the lifecycle, integrated through existing `a2ui-host` injection point. Proves the boundary holds in practice.
3. **Smoke-verifier** (non-author): hostname-null-claude-0 or third agent runs the prototype end-to-end, captures durable artifact, validates metadata-join surface.

## Related rules / banked memory

- `feedback-architectural-boundaries-6-hard-rules` — the layer rules this ADR enforces (especially rule 6)
- `feedback-0.6.0-convergence-mode-freeze-line` — "necessary for release correctness" exception applies
- `feedback-adr-discipline-5-question-gate` — applied during draft
- `feedback-card-vs-gateway-distinction` — transport-vs-behavioral separation principle generalized here to protocol-vs-renderer
