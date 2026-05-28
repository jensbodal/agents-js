# ADR 0008 — SubscribedResponseWakeAdapter: shape-vs-variant decision

**Status**: Proposed (2026-05-27) — STUB. Decision deferred to post-0.6.0.
**Deciders**: TBD (architecture-lead = cognee-claude; implementer-of-record = ajs-claude)
**Affects**: `@agents-js/wake-types` (`WakeAdapterShape` union), prospective `@agents-js/wake-mcp-triggers` extension OR new `@agents-js/wake-subscribed-response` (TBD per this ADR), prospective `extras/mcp-bus-bridge` SSE handling

---

## Context

AJS-98 was filed in Plane (2026-05-27) to add a "SubscribedResponseWakeAdapter" alongside the AJS-96 in-session-push wake-adapter that shipped in PR #82. ajs-claude's critique-first research lane (matrix event `$l6pdbl3APJLv0OVElE0M2SR2uOnnGqNBy0h0b-asEFs`) found that the proposal has three structural ambiguities that must be resolved before any code lands:

1. **Taxonomy collision**: `wake-types/src/index.ts:115` defines `WakeAdapterShape` as a closed 3-member union with explicit doc note "widening requires a new adapter package, not just a new field" and `assertNever`-style dispatch:

   ```ts
   type WakeAdapterShape =
     | "in-session-push"
     | "translator-inject"
     | "spawn-with-signal"
   ```

   "SubscribedResponse" matches none of those names. It is either:
   - A 4th shape requiring union widening + boundary-narrowing-record fan-out + a new package per the doc rule, OR
   - A variant of an existing shape (most plausibly an SSE-transport variant of in-session-push, given `extras/mcp-bus-bridge`'s SSE precedent)

2. **Zero codebase mentions**: grep for `AJS-98 | SubscribedResponse | subscribed-response` returns no hits across `packages/`, `apps/`, `extras/`, `docs/`. No spec anchor exists.

3. **Sync-RPC framing**: The original ticket title `feat(wake-types,wake-subscribed-response): SubscribedResponseWakeAdapter — sync-RPC over Matrix` implies request/response synchrony over a transport (Matrix). That framing crosses the boundary into transport-shape territory (sync-RPC has different semantics from the existing async-push family). This may indicate a fundamentally different transport contract, not a wake-adapter shape extension.

## Why this is deferred to post-0.6.0

Per the 0.6.0 convergence-mode freeze line (Jens 2026-05-27 direction-set event `$29JyIKoyBfOw5zj15vsQSmfs49I6FRX1_EOW5SK7UQ4`), no major new protocol surfaces unless they:
1. Unblock existing flows
2. Close architectural inconsistencies
3. Are necessary for release correctness

SubscribedResponseWakeAdapter qualifies under NONE of these:
- No existing flow needs it (no waiting consumer)
- The "inconsistency" it would close is theoretical — there is no broken contract that requires this shape to exist
- 0.6.0 cuts cleanly without it; AJS-96 dispatcher is sufficient as the additive-shape reference impl

Additionally, the shape-vs-variant decision is a load-bearing architectural choice that affects:
- Union widening (boundary-narrowing-record drift fan-out across `KNOWN_WAKE_ADAPTER_SHAPES_RECORD`)
- Package decomposition (new sibling package vs extending wake-mcp-triggers)
- Transport policy (async-push vs sync-RPC framing)

These choices commit the codebase long-term. Making them under convergence-freeze pressure is the wrong tradeoff.

## Open questions (must answer before any impl)

These map to the 5-question gate from `feedback-adr-discipline-5-question-gate`:

### 1. Shape or variant?

- Is SubscribedResponse a **new 4th shape** in `WakeAdapterShape` (requires union widening + new package + boundary-record update + ADR documenting why the closed-union rule should be relaxed for this specific addition)?
- Or is it a **variant of in-session-push** with a different transport encoding (SSE bus event format vs MCP notification format)? In this case it would live as a sibling helper in `@agents-js/wake-mcp-triggers`, not as a new shape.
- **Consequences**: shape-tier vs variant-tier decision affects type system, package boundary, dispatcher/receiver pairing.

### 2. Sync-RPC vs async-push semantics

- If sync-RPC: this is a request/response contract over a transport. That's fundamentally different from the existing wake-adapter family (one-shot push with audit-once invariant).
- If async-push: the "subscribed-response" framing might just mean "the receiver subscribes to a channel and the dispatcher pushes responses correlated to prior requests." That's still async-push with a different idempotency-key scheme.
- **Consequences**: sync-RPC requires response-channel infrastructure (timeouts, retries, correlation IDs). Async-push fits the existing audit-once model.

### 3. Transport — Matrix native?

- The original ticket title mentions "over Matrix." Does this shape have a specific transport binding (Matrix-only) or is it transport-agnostic like the existing shapes?
- **Consequences**: transport-specific shapes are an anti-pattern per the 6 hard rules (gateway = pure transport translation, NOT prompt/policy middleware). If this requires Matrix-only behavior, it may belong in dot-matrix, not agents-js.

### 4. Cross-host vs in-session

- AJS-96 in-session-push is INSIDE a single ACP session's MCP context.
- Does SubscribedResponse operate cross-host (peer agents on different machines) or in-session?
- **Consequences**: cross-host implies federation-tier (different package, different security posture, different latency profile).

### 5. Layer ownership

- If shape: `@agents-js/wake-types` (new union member) + new `@agents-js/wake-subscribed-response` package (per doc rule)
- If variant: `@agents-js/wake-mcp-triggers` (extension to existing package)
- If transport-specific Matrix-binding: dot-matrix repo, not agents-js
- **Consequences**: cross-repo work (Matrix-bound case) means this ticket should be DOT-prefixed, not AJS, per Tenet 23.

## Cross-references

- **AJS-89**: HYBRID wake-adapter SHAPES axis banked decision (closed 3-member union enforcement)
- **AJS-96 / PR #82**: in-session-push dispatcher package (shipped) — additive-shape pattern reference impl
- **AJS-98 ticket**: filed in Plane prior to research; pending shape-vs-variant resolution
- **ADR-0007**: wake-trigger gateway substrate — separate but adjacent deferral (consumer-integration gap)
- **ajs-claude 2026-05-27 research lane**: surfaced the taxonomy collision (matrix event `$l6pdbl3APJLv0OVElE0M2SR2uOnnGqNBy0h0b-asEFs`)
- **0.6.0 convergence-mode direction**: Jens 2026-05-27 event `$29JyIKoyBfOw5zj15vsQSmfs49I6FRX1_EOW5SK7UQ4`
- **Tenet 23** (project scope discipline, dot-cognee 377b31a): if layer ownership resolves to Matrix-binding, ticket must be DOT-prefixed

## Status sequencing

- **0.6.0**: AJS-98 stays parked. AJS-96 dispatcher remains the only wake-adapter shape package in main as additive-shape reference impl.
- **Post-0.6.0**: ADR-0008 resolution + (if shape-tier) sibling package creation OR (if variant-tier) wake-mcp-triggers extension OR (if Matrix-binding) reclassification to DOT.
- **Decision authority**: cognee-claude (architecture-lead) + ajs-claude (implementer-of-record) peer-convergence per buddy-system.

## Sibling-shape filing implications

Per Jens's 2026-05-27 direction-set (B3), AJS-99 (transport wake/queue semantics) and AJS-100 (harness behavioral switching) were named for sibling-shape work AFTER AJS-96 validates the additive-shape pattern. If ADR-0008 resolves SubscribedResponse as a 4th shape, then AJS-99/AJS-100 sequencing depends on this ADR's outcome. If it resolves as a variant, AJS-99/AJS-100 file independently.

## Related rules

- `feedback-adr-discipline-5-question-gate` — 5-question gate before new architecture work
- `feedback-architectural-boundaries-6-hard-rules` — gateway = transport translation, not policy middleware
- `feedback-no-speculative-packaging` — new primitive ≠ new package; default to extending existing
- `feedback-card-vs-gateway-distinction` — separation of gateway-transport from harness-behavioral
