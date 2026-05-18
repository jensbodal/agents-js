# ADR 0002 — Public agents-js inbound transport abstraction

**Status**: Accepted (2026-05-18)
**Deciders**: ajs-claude, cognee-claude, cognee-codex, dot-proxmox (4-way peer convergence)
**Affects**: `@agents-js/host`, `@agents-js/gateway-runtime`, `extras/matrix-bridge`, future transport adapters (Slack, webhook, audio, etc.)

---

## Context

`@agents-js` ships an in-process bus on the internal gateway with `/admin/publish` + `/events` SSE endpoints (`packages/host/src/bus-endpoint.ts`), and `HostA2AExecutor` provides `@@target`-prefix dispatch routing through a registry (proven empirically by gitea PR #28, test `host-executor-acp-dispatch.test.ts:10a`). These primitives exist in code but have not been organized into a **public** abstraction with explicit transport-neutrality.

Today the only working transport consumer is `dot-matrix/matrix_nio_bridge.py`, which bypasses the bus and uses direct HTTP A2A dispatch per "DOT-393 Phase B step 2.5." Planned Wave 2 work (slices E4.0-b, E4.1 Slack, E4.3 audio, E4.4 webhook ingress, E4.5 matrix protocol expansion) all assume some flavor of "transport adapter publishes inbound events; agents-js dispatches." Without a public-abstraction boundary, each transport adapter risks re-implementing the wheel slightly differently and coupling to Matrix-specific assumptions baked into the existing path.

Direction from Jens (2026-05-18 20:25 PDT) explicitly framed the product goal: *"Codex app on hostname-null should be able to have its own Matrix identity via agents-js, using a common public agents-js abstraction with our q4m/internal Matrix implementation underneath… do not make this a one-off Matrix bridge special case or a hostname-null-only hack."*

This ADR locks the public surface so consumers (Matrix today, Slack/webhook/audio tomorrow) plug into the same contract.

## Decision

The public agents-js inbound transport abstraction comprises four surfaces. Each surface has a transport-neutral type contract; transport-specific concrete implementations layer beneath.

### Surface 1 — Agent identity

```typescript
export type IdentityPrincipalKind =
  | "agent"           // first-party agents-js agent
  | "human"           // human user (any transport)
  | "service"         // automated service (ci/cron/etc.)
  | "matrix-user"     // matrix-native identity
  | "slack-user"      // slack-native identity (future)
  | "webhook-source"; // generic webhook-attributed identity (future)

export interface IdentityPrincipal {
  kind: IdentityPrincipalKind;
  actorId: string;
  displayName?: string;
}
```

`IdentityPrincipalKind` is a **closed union**. New transport kinds are added via ADR amendment, not by opening the type to `(string & {})`. Closed-union forces type narrowing at consumer boundaries and prevents silent drift of identity semantics.

**Implicit AC (per dot-proxmox `--transport none` correction)**: the public abstraction must support agents that exist OUTSIDE `AGENT_SESSIONS` / bridge-tmux management. `codex-hostname-null` is the canonical example — it has a Matrix identity (`@codex-hostname-null:matrix.tail019e7.ts.net`) without a tmux pane or `AGENT_SESSIONS` entry. The identity surface MUST NOT assume bridge-managed lifecycle.

### Surface 2 — Inbound event envelope

```typescript
export interface InboundEventEnvelope<TPayload = unknown> {
  topic: string;                       // `gateway.<transport>.<event-type>` convention
  sourcePrincipal: IdentityPrincipal;  // who/what produced the event at the transport
  payload: TPayload;                   // transport-specific event body, opaque to substrate
  metadata: {
    correlationId: string;             // ULID/UUID; threads request → reply
    ts: string;                        // ISO-8601 emission timestamp
    sourceEvent?: Record<string, unknown>; // transport-specific raw event for audit/debug
  };
}
```

Topic naming convention: `gateway.<transport>.<event-type>`. Examples: `gateway.matrix.event-received`, `gateway.slack.message`, `gateway.webhook.received`, `gateway.audio.frame-received`. Substrate routing is on topic patterns; consumers subscribe to topic globs.

Payload is **opaque at substrate**. Consumer-side schemas (e.g., a Matrix-room-message shape) layer above and are validated at consumer boundaries, not at the bus.

### Surface 3 — Dispatch intent

`HostA2AExecutor` `@@target`-prefix routing + dispatch registry, already shipped and verified by PR #28. The dispatch surface IS transport-invariant: any inbound event whose payload contains an `@@target` directive routes through the same `HostA2AExecutor` → dispatch registry → target A2A gateway → target ACP runtime path. This ADR codifies the existing surface as the public dispatch contract; it does not add new shape.

Reference: `packages/host/src/host-executor.ts` + `packages/host/tests/host-executor-acp-dispatch.test.ts:10a`.

### Surface 4 — Result + presence

```typescript
export interface OutboundReplyEnvelope<TPayload = unknown> {
  topic: string;                       // `gateway.<transport>.reply-sent` convention
  targetPrincipal: IdentityPrincipal;  // who/what receives the reply at the transport
  payload: TPayload;                   // transport-specific reply body
  inReplyTo?: {
    correlationId: string;             // matches the inbound envelope that triggered this
    sourceEventRef?: string;           // optional transport-native reference (e.g., Matrix event_id)
  };
  metadata: {
    correlationId: string;
    ts: string;
  };
}

export interface PresenceEnvelope {
  topic: string;                       // `gateway.<transport>.presence` convention
  principal: IdentityPrincipal;        // whose presence
  state: "online" | "offline" | "idle" | "busy";
  metadata: {
    ts: string;
    expiresAt?: string;                // optional TTL for presence freshness
  };
}
```

Multi-consumer fan-out: `mcp-bus-bridge`, the matrix replier daemon, and future consumers all subscribe to `gateway.*.reply-sent` and `gateway.*.presence` topics independently. The bus dispatches each event to all matching subscribers; no consumer claims exclusive ownership.

### Consumer-facing interface

```typescript
export interface InboundTransportConsumer<TInbound = unknown, TOutbound = unknown> {
  readonly transportName: string;      // "matrix" | "slack" | "webhook" | "audio" | ...
  publishInbound(event: InboundEventEnvelope<TInbound>): Promise<void>;
  subscribeOutbound(
    pattern: string,
    handler: (event: OutboundReplyEnvelope<TOutbound>) => Promise<void>,
  ): () => void; // returns unsubscribe handle
  shutdown(): Promise<void>;
}
```

Each transport adapter implements this interface. The Matrix bridge wraps `matrix_nio_bridge.py` and publishes via `publishInbound`; future Slack/Discord/webhook adapters implement the same interface against their native APIs.

## Refutation of "Matrix-bridge-only" framing

The previous E4.0-b sketch centered on `matrix_nio_bridge.py` swapping HTTP-direct dispatch for `/admin/publish` calls. That framing makes Matrix the protagonist of the abstraction; a Slack adapter shipped under that framing would force `matrix_nio_bridge.py`-like assumptions into Slack's onboarding flow.

The 4-surface decomposition inverts the protagonist: the **agents-js abstraction is the protagonist**, and Matrix is the first concrete `InboundTransportConsumer` implementation. Slack/webhook/audio/Discord each ship as additional concrete implementations of the same interface. No transport claims "primary" status at the substrate.

This matches the cognee-style "one abstraction, many transports" architectural pattern already evident in the AG-UI / A2UI / ACP layering elsewhere in agents-js.

## Alternatives considered

### Alternative A — Add only the transport-neutrality AC to a narrow E4-OQ1

Rejected (codex + dot-proxmox + claude + ajs-claude 4-way convergence). The "narrow OQ with one extra AC" framing would have left the 4 surfaces implicit. Without explicit type contracts per surface, downstream consumers would re-invent slight variations of each shape, producing the exact Matrix-special-casing this ADR is meant to prevent.

### Alternative B — File 4 separate OQs/ADRs (one per surface)

Rejected. The 4 surfaces are mutually constraining: the identity surface shapes how `sourcePrincipal` is typed in the event envelope; the event envelope shapes how the dispatch surface receives routing inputs; the result surface mirrors envelope correlation. Four separate ADRs would invite drift between surfaces. One ADR with four sections preserves coherence.

### Alternative C — Open `IdentityPrincipalKind` as `(string & {})` for extensibility

Rejected. Open-union appears flexible but defeats the type-narrowing guarantees that make `IdentityPrincipal` useful at consumer boundaries. New transports adding new identity kinds is rare enough that ADR amendment is the right cadence. Open-string is a refactoring hazard in disguise.

### Alternative D — Defer surfaces 2-4 to later ADRs once Surface 1 is locked

Rejected. Locking Surface 1 (identity) without the corresponding envelope/dispatch/result shapes leaves Wave 2 implementers without enough contract to build against. The four surfaces together are the minimum coherent contract; partial release would force re-litigation downstream.

## Consequences

### Required (acceptance criteria)

- **SemVer minor bump** on `@agents-js/host` (where `IdentityPrincipal` + bus surface live): `0.5.x` → `0.6.0` (additive interface widening, existing consumers preserved).
- **Type additions** in `packages/host/src/`:
  - Widen `IdentityPrincipalKind` closed-union to include transport-source kinds (`matrix-user`, `slack-user`, `webhook-source`, etc.) as listed under Surface 1
  - Add `InboundEventEnvelope<TPayload>` (Surface 2)
  - Add `OutboundReplyEnvelope<TPayload>` + `PresenceEnvelope` (Surface 4)
  - Add `InboundTransportConsumer<TInbound, TOutbound>` interface
- **Conformance harness**: `runInboundTransportConformanceTests({ adapter })` exercises all four surfaces against any consumer. Matrix is the first implementation under test; the same harness must pass for any future transport.
- **No bridge-tmux assumption**: identity types must NOT require `AGENT_SESSIONS` registration; `--transport none` agents (`codex-hostname-null` is the canonical example) are first-class.
- **In-file doctrine** at type-definition sites: each new type carries a doc comment explaining its surface (1-4) and the transport-neutral guarantee.
- **Doc updates**: `docs/primitives.md` + `docs/protocols.md` gain a "Public Inbound Transport Abstraction" section; existing federation contract doc cross-links.

### Out of scope (deferred to follow-up ADRs / implementation PRs)

- **First consumer implementation** (slice E4.0-b) — `extras/matrix-bridge` wired as the first `InboundTransportConsumer`. Implementation PR rebases on this ADR.
- **Slack/webhook/audio consumers** (slices E4.1, E4.3, E4.4) — each ships as a separate PR against the locked interface. No interface changes required.
- **mcp-bus-bridge → push-notification loop** (slice E4.2) — reshapes to a thin consumer atop the abstraction.
- **Bridge dispatch swap** (`matrix_nio_bridge.py` from HTTP-direct A2A to `publishInbound`) — sequenced inside E4.0-b's PR per the locked 3-slice decomposition; cognee-claude reviewer scope.

### Downstream consumer impact

- **`extras/matrix-bridge`** (TypeScript envelope builder) gains an `InboundTransportConsumer` implementation; the existing envelope-building logic moves into the consumer's `publishInbound` path.
- **`dot-matrix/matrix_nio_bridge.py`** (Python, in dot-matrix repo) loses the direct-HTTP-A2A path and gains a `/admin/publish` POST path, with the existing DOT-393 Phase B fallback preserved. Implementation lives in dot-matrix repo, not agents-js; reviewer scope is cognee-claude.
- **`codex-hostname-null`** (newly onboarded with `--transport none`) consumes the abstraction without any `AGENT_SESSIONS` involvement. Validates the no-bridge-tmux-assumption AC.
- **`@agents-js/a2a` federation client** is unaffected: federation transport is Epic 1 territory, not inbound transport.

## Provenance

- **Surfaced**: Jens's product-goal direction (Matrix room 2026-05-18 20:25 PDT) reframed the narrow E4-OQ1 (`IdentityPrincipal.kind` only) into the broader public-abstraction question.
- **Locked via 4-way peer convergence**: cognee-codex (empirical proof at gitea PR #28; framing correction on HostA2AExecutor dispatch path being the primary axis); cognee-claude (initial A/B/C/D taxonomy; bridge-side implementation context for E4.0-b); dot-proxmox (`--transport none` correction; identity must not assume `AGENT_SESSIONS`); ajs-claude (4-surface decomposition; vault doc synthesis). Convergence captured in Matrix room messages 2026-05-18 20:08-20:30 PDT.
- **Vault doc cross-reference**: `~/workspace/syncthing/lifestone_ios/workspace/agents-js/docs/research/epic-parallelism-plan-2026-05-18.md` under the E4-OQ1 expanded resolution + E4.0 sub-slice decomposition.
- **Empirical baseline**: gitea PR #28 (`codex/e4-two-gateway-dispatch-proof`) codifies the dispatch path that Surface 3 references.
