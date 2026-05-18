# ADR 0003 — Federation bus event payload shape

**Status**: Accepted (2026-05-18, peer-reviewed)
**Deciders**: ajs-claude (proposer), cognee-codex (peer review tweak — `attachmentId` rename to disambiguate from bus envelope's top-level `correlationId`), cognee-claude (peer ack)
**Affects**: `@agents-js/gateway-runtime`, `@agents-js/host` (bus event publishers + types)

---

## Context

E1.D — "Federation join/leave bus events + publishers" — is a Wave-2 slice that adds `gateway.federation.child-attached` and `gateway.federation.child-detached` topics to the gateway's in-process bus. These events fire whenever a federated child gateway attaches or detaches from a parent gateway, letting downstream consumers (admin UIs, audit pipelines, observability tools) react to fleet membership changes.

The open question for v1 of these events: **what shape does the event payload take?** Two readings have been considered:

1. **Embed the full agent card** in every attached event payload. Pros: consumers don't need a follow-up fetch; one event, one render. Cons: payloads inflate to 5-20KB+ depending on card complexity (capabilities array, skills list, federation metadata). Attach storms during reconnect cycles multiply the cost.
2. **Federation envelope only** (childAgentId + gatewayUrl + mode + attachmentId). Pros: small payload (~200 bytes), bus stays cheap. Cons: consumers that want card data must fetch via `/.well-known/agent-card.json` separately.

E2-OQ1 (memory provider substrate reads) set a precedent: substrate primitives stay narrow; consumer-layer enrichment composes above. Federation bus events are similarly substrate-level (the bus is a transport, not a UI rendering layer), which biases toward the envelope-only path.

## Decision

**Federation envelope only.** Bus event payloads carry routing identity and cache invalidation hints; consumers fetch the full agent card on demand via the existing `/.well-known/agent-card.json` route (shipped by AJS-23 T2) and cache by `childAgentId` until a detached event invalidates the cache.

### Payload shapes

```typescript
export interface FederationChildAttachedPayload {
  /** Stable agent identifier for this federated child. */
  childAgentId: string;
  /** Resolvable URL where the child gateway serves its A2A endpoint. */
  gatewayUrl: string;
  /** How the child's hostname is resolved (matches AJS-23 contract). */
  hostnameMode: "resolvable" | "null";
  /** Coordinator URL — REQUIRED when hostnameMode === "null", otherwise absent. */
  coordinatorUrl?: string;
  /** ISO-8601 timestamp of attach event emission. */
  attachedAt: string;
  /**
   * Per-attachment identifier (NOT a correlation token). Threads the
   * attach event with its later detach event for the same `(childAgentId,
   * gatewayUrl)` lifecycle pair. Distinct from the bus envelope's
   * top-level `metadata.correlationId` (which threads inbound→outbound
   * within one consumer interaction); `attachmentId` threads
   * attach→detach across the federation lifecycle.
   */
  attachmentId: string;
}

export interface FederationChildDetachedPayload {
  /** Same child as the prior attached event. */
  childAgentId: string;
  /** Same gateway URL as the prior attached event (snapshot at attach time). */
  gatewayUrl: string;
  /** ISO-8601 timestamp of detach event emission. */
  detachedAt: string;
  /** Why the child detached. */
  reason: "graceful" | "crash" | "transport-error" | "timeout";
  /** Matches the prior attached event's `attachmentId`, threading the pair. */
  attachmentId: string;
}
```

**Naming rationale (peer-review fold)**: an earlier draft used `correlationId` here, which would have collided with the bus envelope's top-level `metadata.correlationId` (ADR 0002 surface #2). Same field name, different threading semantics — that's the kind of overload that costs consumer-side debugging time. `attachmentId` makes the per-lifecycle identifier self-documenting and disambiguates from inbound→outbound correlation in the envelope.

### Consumer pattern

```typescript
// Consumer subscribes to attached/detached topics
const cardCache = new Map<string, AgentCardLike>();

bus.subscribe("gateway.federation.child-attached", async (event) => {
  const payload = event.payload as FederationChildAttachedPayload;
  // Defer card fetch — let the consumer decide when (lazy on first use,
  // eager on attach, never if they only need routing identity).
  // Cache key is childAgentId; invalidate on detach.
});

bus.subscribe("gateway.federation.child-detached", async (event) => {
  const payload = event.payload as FederationChildDetachedPayload;
  cardCache.delete(payload.childAgentId);
});
```

## Refutation of "embed full card"

Three concerns against full-card embedding:

1. **Reconnect storms inflate cost asymmetrically.** A fleet of 50 federated children each going through a brief network blip causes 50 detach + 50 attach events in close succession. With full cards embedded, that's 50 × ~10KB = 500KB of bus traffic per reconnect cycle. With envelope-only, it's 50 × ~200 bytes = 10KB. The bus is in-process today but consumers may proxy events to external observability tools where the bandwidth matters.
2. **Card payload is consumer-layer concern, not transport concern.** The bus event represents "this child joined/left the fleet" — a routing fact. The card represents "here's what this child can do" — a capability fact. Conflating them in one event ties consumers to the transport's view of the world.
3. **Cache invalidation is simpler with envelope-only.** Detach events are the natural cache-bust signal. With full-card embedding, attach events also serve as a cache-bust (the card may have changed since last attach), but consumers can't tell whether to invalidate or keep a stale entry without comparing card hashes. Envelope-only forces a clean fetch on first use after attach.

## Alternatives considered

### Alternative A — Full agent card embedded

Rejected. Inflation cost + abstraction conflation per refutation above.

### Alternative B — Hybrid: envelope by default, optional card field

Rejected. The hybrid invites "well, sometimes the card is there, sometimes it isn't" branching at every consumer site. Worse than either pure design — consumers either always fetch (and waste the embedded card) or check-then-fetch (and the embedded card is dead weight in 99% of cases).

### Alternative C — Envelope only, no detach event

Rejected. Without detach, consumers can't invalidate their card cache without polling. The detach event is cheap (same envelope shape as attach) and gives consumers a clean signal.

### Alternative D — Add a `cardHash` field for cache-bust hint

Considered. Adds 32-64 bytes per envelope but lets consumers skip a fetch if their cached card hash matches. **Deferred to a v2 ADR** if real usage shows consumer-side fetch volume is a problem. v1 keeps the surface minimal.

## Consequences

### Required (acceptance criteria)

- **SemVer minor bump** on `@agents-js/gateway-runtime` (where federation publishers will live). Per v0 versioning scheme: `0.5.x` → `0.6.0` (additive type + publisher additions).
- **Type exports** from `gateway-runtime` barrel:
  - `FederationChildAttachedPayload`
  - `FederationChildDetachedPayload`
- **Publisher implementation** in `packages/host/src/gateway-bus-publishers.ts` (or equivalent):
  - `publishFederationChildAttached(bus, payload)` — emits typed event on `gateway.federation.child-attached` topic
  - `publishFederationChildDetached(bus, payload)` — emits typed event on `gateway.federation.child-detached` topic
  - Correlation: attach assigns a fresh `attachmentId`; detach reuses the attach's `attachmentId` for the same `(childAgentId, gatewayUrl)` pair. Bus envelope's `metadata.correlationId` (ADR 0002) is unchanged and orthogonal — that handles inbound→outbound threading per consumer interaction.
- **Conformance test**:
  - Payload schema validates against fixture; full agent card NOT present in payload
  - Consumer can fetch card via `/.well-known/agent-card.json` after receiving attached event
  - Reattach (after detach) emits a fresh `attachmentId`
  - `coordinatorUrl` present iff `hostnameMode === "null"`
- **Doc updates**: `docs/federation/v1-contract.md` adds event payload section with the two type definitions and the consumer pattern.

### Out of scope (deferred)

- **`cardHash` cache-bust hint** (Alternative D) — defer until consumer-side fetch volume is shown to be a problem.
- **Bus event versioning header** — defer until a second payload version exists.
- **Persistent event log** for federation events — orthogonal to payload shape; tracked separately.

### Downstream consumer impact

- **`apps/internal-gateway`** — the canonical federation publisher consumer. Wires publish calls into the existing federation attach/detach lifecycle.
- **`@agents-js/a2a-client`** — federation transport (slice E1.B) uses `attachmentId` from attached events to thread subsequent dispatch operations against the same federated child lifecycle.
- **Future observability consumers** (mcp-bus-bridge, federation status panel in E3) — subscribe to both topics, fetch cards lazily.

## Provenance

- **Surfaced**: E1-OQ1 in vault planning doc `~/workspace/syncthing/lifestone_ios/workspace/agents-js/docs/research/epic-parallelism-plan-2026-05-18.md`.
- **Peer-reviewed**: cognee-codex's `attachmentId` rename tweak (Matrix event `$jp9bxgYb6_E7u-LUASjxJpKUDKj5v4IGJKoINoswWT8`, 2026-05-18 21:06 PDT) folded; cognee-claude resurfaced the un-folded review at $rZi3TO1T23YfqwvhB0VK6xZ6kG_9lGKxtr1IgI8fPwY (22:15 PDT); ADR amended pre-merge.
- **Convention alignment**: follows the template established by ADR 0001 + 0002 (Context / Decision / Refutation / Alternatives / Consequences / Provenance).
