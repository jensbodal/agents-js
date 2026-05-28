# ADR 0007 — Wake-trigger gateway substrate

**Status**: Proposed (2026-05-27) — **Re-classified in-0.6.0 per Jens 2026-05-28 sign-off**. Original "deferred post-0.6.0" status superseded.
**Deciders**: cognee-claude (architecture-lead), ajs-claude (publishable-surface implementer), hostname-null-claude-0 (harness wire-up + channel adapter integration)
**Affects**: `@agents-js/wake-mcp-triggers` (dispatcher half, shipped), `extras/mcp-bus-bridge`, prospective `@agents-js/wake-signal-store` (new), prospective `@agents-js/host` trigger publisher (new), prospective `@agents-js/channel-adapter` (new — see Revision 2026-05-28), gateway dispatch path

---

## Revision 2026-05-28 — Terminal adapter shape correction + in-0.6.0 re-classification

Jens 2026-05-28 directive (relayed via hostname-null-claude-0 matrix event `$RNR3fze_Kq7jXHoKcXcqYySVOtGfUErHE3LLydx8M1w`) re-classifies this work from post-0.6.0 to in-0.6.0 scope. The convergence-mode "necessary for release correctness" exception applies because shipping 0.6.0 with the receiver-side wake-push gap unresolved would leave the AJS-89 HYBRID architecture half-shipped at the runtime layer, not just at the package layer (PR #82).

hostname-null-claude-0's harness research surfaced a **decisive finding** that invalidates the original ADR's terminal-hop assumption:

**Finding**: Claude Code's MCP client **silently ignores server-initiated `notifications/*` frames**. The "Claude Code harness registers a `notifications/wake` handler" assumption from the original ADR cannot be built as specified.

**Real Claude Code push primitive**: **Channels** (`claude/channel` capability, launched via `--channels`; research preview ~v2.1.80+). A channel = an MCP server declaring `claude/channel` that pushes messages INTO a running session and wakes it. Official channel plugins exist (Telegram/Discord/iMessage); custom channels are buildable.

**Re-scoped architecture** (the original ADR's gateway-side decisions still hold; terminal adapter shape changes):
- **KEEP as the SOURCE** (still needed; this ADR's core gateway-side decisions hold): WakeSignalStore + trigger publisher + gateway wake bus events. Something must decide "idle agent X has inbound → wake."
- **REUSE**: gateway SSE `/events` bus + the `extras/mcp-bus-bridge` SSE→stdio pattern (`mcp-bus-bridge` already does `dispatchNotification` / `server.notification`).
- **CHANGE**: terminal adapter for Claude Code becomes a **`claude/channel`-capable MCP server** (new `@agents-js/channel-adapter` or sibling package) attached via `--channels`, translating gateway wake/inbox events into channel messages. **NOT** a `notifications/wake` emitter.

**Implication for ADR-0008** (SubscribedResponseWakeAdapter shape-vs-variant): for Claude Code specifically, the SubscribedResponse path may be moot once the channel adapter is built — Channels solves the receiver gap. For Codex and other sync-only harnesses that lack a Channels equivalent, ADR-0008's open questions remain (sibling-shape work, transport-binding decisions still required).

**Fallbacks that work today, zero new harness capability** (carry-forward from hostname-null research, useful for unblocking pre-channel-adapter work):
- External supervisor spawns `claude -p "<event>"` per inbound gateway event (stateless; fastest unblock)
- Claude Agent SDK driven by a gateway-event loop (stateful, production-grade)

**Updated implication for the 5 OQs below**: gateway-side OQs (1, 2, 5) remain load-bearing under the channel-adapter framing. OQ 3 (method-namespace `notifications/wake`) is now partially resolved — for Claude Code the terminal adapter uses `claude/channel` not `notifications/wake`; for other harnesses the original namespace question still applies. OQ 4 (bridge prefix-filter) becomes a channel-adapter capability-declaration question for Claude Code.

**0.6.0 scope under this revision**:
- WakeSignalStore primitive (package location TBD per OQ 1)
- Trigger publisher (location TBD per OQ 1)
- `@agents-js/channel-adapter` (or sibling) — `claude/channel`-capable MCP server translating gateway wake/inbox events into Claude Code channel messages
- Integration through `mcp-bus-bridge` SSE event surface (reused, not new)
- Estimated total: ~1500-2000 LOC across store + publisher + channel adapter. Non-trivial but no time pressure (Jens 2026-05-28 confirmed no cut-date).

**DRI map**:
- Architecture call (store location/persistence boundary, bridge contract, channel adapter contract): cognee-claude
- Publishable-surface packages (WakeSignalStore, trigger publisher, channel adapter MCP server): ajs-claude
- Harness wire-up + channel adapter integration testing: hostname-null-claude-0
- Smoke-verifier: cognee-codex or cognee-zai (buddy-system third role; non-implementer non-reviewer)

---

## Context

`@agents-js/wake-mcp-triggers` shipped in PR #82 (AJS-96) as the dispatcher half of the AJS-89 HYBRID in-session-push wake-adapter shape. The package exports `createInSessionPushDispatcher`, `createInSessionPushReceiver`, `parseInSessionPushNotification`, and `serializeInSessionPushAdapter` — all pure functions and audit-once invariant handles.

The consumer-side integration was implicitly assumed to be a follow-up "wiring PR" against the gateway dispatch path. ajs-claude's critique-first research lane (2026-05-27) discovered this assumption is structurally wrong:

1. **Sink ownership**: The gateway is an A2A/AG-UI HTTP/WS server. It does NOT own an MCP session to push wake notifications into. The only MCP-into-harness channel that exists is `extras/mcp-bus-bridge`, which is **harness-spawned** (subscribes to gateway's SSE `/events`, emits MCP notifications over its own stdio). The bridge is the sink owner; the gateway's contribution is purely *publish a wake bus event*.
2. **Missing substrate**: AJS-89's banked decision says "gateway owns durable wake signal store." That store is **absent from the codebase** — zero matches for `WakeSignalStore | wake-publisher | gateway.wake.*` across `packages/`, `apps/`, `extras/`.

The "published-but-dormant" gap is not a 200-line wiring patch. It's design-then-wiring across two missing layers:
- A **WakeSignalStore** primitive (location + persistence boundary TBD)
- A **trigger publisher** that decides when to publish wake-signals (location + transport boundary TBD)

Realistic scope if executed: ~900-1100 LOC across 3 packages (`packages/wake-signal-store/` (new), `extras/mcp-bus-bridge` changes, trigger publisher in `packages/host/` or sibling).

## Why this is deferred to post-0.6.0

Per the 0.6.0 convergence-mode freeze line (Jens 2026-05-27 direction-set event `$29JyIKoyBfOw5zj15vsQSmfs49I6FRX1_EOW5SK7UQ4`), no major new protocol surfaces unless they:
1. Unblock existing flows
2. Close architectural inconsistencies
3. Are necessary for release correctness

Wake-trigger gateway substrate qualifies under NONE of these:
- The flow it would enable doesn't exist yet (there's no waiting consumer)
- It would CREATE new architecture, not close existing inconsistency
- 0.6.0 cuts cleanly without it; the AJS-96 package being dormant is annotation-fixable in the meantime

The AJS-96 in-session-push dispatcher package shipped is a useful foundation for future work even without consumer integration. It is a published reference impl of the additive-shape pattern (validating that new wake-adapter shapes can land as sibling packages under `@agents-js/wake-mcp-triggers` without widening the closed `WakeAdapterShape` union).

## Open questions (5 ADR-required decisions before any impl)

These are the structural decisions that must be answered before code lands. Each maps to the 5-question gate from the architecture-lead heuristic.

### 1. WakeSignalStore location + persistence boundary

- **Layer ownership**: New package `@agents-js/wake-signal-store`, fold into `@agents-js/host`, or fold into `@agents-js/gateway-runtime`?
- **Persistence**: In-memory v1 (lose signals on gateway restart), SQLite (durable per-gateway), or Postgres (durable + multi-replica gateway)?
- **Consequences**: Drives idempotency/dedup semantics, multi-host federation, gateway restart-recovery.

### 2. Trigger source — single decider or N aggregated bus events

- Is it one decider (e.g., matrix-bus-consumer deciding "idle harness, not sync dispatch") that emits trigger events, or N source events aggregated by a trigger publisher?
- Single queue with all triggers, or per-target lanes (per-agent or per-session)?
- **Consequences**: Drives fairness, prioritization, ordering guarantees, backpressure semantics.

### 3. Method-namespace collision

- AJS-96 dispatcher uses `notifications/wake` (per `DEFAULT_WAKE_NOTIFICATION_METHOD`).
- Existing bridge uses `notifications/gateway-bus/event` for general SSE event delivery.
- Should wake notifications be a sibling under `notifications/gateway-bus/wake`, kept as `notifications/wake`, or use a different namespace entirely?
- **Consequences**: Drives bridge routing logic, prefix-filtering, operator-discoverability.

### 4. Bridge prefix-filter — default-allowed or operator-opt-in

- Should the mcp-bus-bridge default to delivering wake notifications when the harness opens (default-allowed) or require operator-opt-in (allowlist)?
- **Consequences**: Drives security posture, default-fail-mode (fail-open vs fail-closed), harness boot semantics.

### 5. Target resolution — bridge-side or store-side

- The bridge has no session→agent registry today; it operates on raw MCP stdio handles.
- Should target resolution (which harness to wake) happen store-side (publisher writes resolved target) or bridge-side (publisher writes abstract target, bridge resolves)?
- **Consequences**: Drives registry surface, multi-session-per-agent semantics, dispatch-vs-broadcast posture.

## Cross-references

- **AJS-89**: HYBRID wake-adapter SHAPES axis banked decision
- **AJS-96 / PR #82**: in-session-push dispatcher package (shipped)
- **PR #82 review**: cognee-claude approved on architecture/test grounds; consumer-integration verification gap surfaced retrospectively
- **ajs-claude 2026-05-27 research lane**: surfaced the substrate gap (matrix event `$Tgu6sF1y0PZeqsgS-gBUi2EMYM9iPEQkZcqT2LOqsM0`)
- **0.6.0 convergence-mode direction**: Jens 2026-05-27 event `$29JyIKoyBfOw5zj15vsQSmfs49I6FRX1_EOW5SK7UQ4`

## Status sequencing

- **0.6.0**: AJS-96 package stays in main as dispatcher reference impl. Add docstring annotation clarifying consumer integration is deferred to ADR-0007.
- **Post-0.6.0**: ADR-0007 resolution + impl dispatch on the 5 OQs above.
- **Decision authority**: cognee-claude (architecture-lead) + ajs-claude (implementer-of-record) peer-convergence; Jens consulted if cross-repo boundaries shift.

## Self-correction note

This ADR exists because PR #82 was approved without architecture-lead verification of the consumer-side integration path. The 5-question gate was applied to the dispatcher package in isolation, not to the dispatcher-plus-consumer-architecture. Banking forward: when approving a new package that's an architecture sub-component (dispatcher / receiver / store), explicitly verify the consumer-side path is either already-built or scoped as a follow-up PR with concrete deliverables — NOT "wiring is a follow-up" hand-wave.
