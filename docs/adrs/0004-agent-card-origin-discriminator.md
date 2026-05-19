# ADR 0004 — Agent card federation origin: reuse existing `source`/`remote` contract

**Status**: Accepted (2026-05-18, peer-reviewed — substantive amendment to pre-review draft)
**Deciders**: ajs-claude (proposer), cognee-codex (peer review amendment — flagged parallel-contract problem, pivoted ADR to reuse existing AJS-23 T2 wire contract), cognee-claude (peer ack)
**Affects**: `@agents-js/ui-components` (`acp-agent-card` component consumer pattern), `@agents-js/a2a` (existing federation contract — UNCHANGED)

---

## Context

E3.B — "Agent-card surface component" — is a Wave-1 slice that ships an `acp-agent-card` Lit component for rendering agent identity in review UIs and the web-ui. The component needs to discriminate **federation origin**: is this agent running locally (in-process or co-located gateway) or running remotely (on a federated gateway in another process / host)?

A pre-review draft of this ADR proposed introducing a NEW field `AgentCardLike.origin` with a discriminated union shape. cognee-codex's peer review (Matrix `$jp9bxgYb6_E7u-LUASjxJpKUDKj5v4IGJKoINoswWT8`, 2026-05-18 21:06 PDT) caught a structural problem: the agents-js repo **already has a discriminated federation-origin contract** — `HarnessCapabilityEntry` in `packages/a2a/src/discovery.ts`, shipped as part of AJS-23 T2:

```typescript
// Already shipped, packages/a2a/src/discovery.ts:39-83
export type HarnessCapabilityEntry = HarnessCapabilityEntryBase &
  (HarnessLocalOrigin | HarnessRemoteOrigin);

interface HarnessLocalOrigin {
  source?: "local";  // omitted defaults to "local" for back-compat
  remote?: never;
}

interface HarnessRemoteOrigin {
  source: "remote";
  remote: {
    gatewayUrl: string;
    hostnameMode: "resolvable" | "null";
    coordinatorUrl?: string;
    childAgentId: string;
  };
}
```

Introducing a parallel `AgentCardLike.origin` field with similar-but-different semantics (different discriminator name, different field shape, omitted hostname/coordinator metadata) would have created two federation-origin contracts on different surfaces that consumers must reconcile. That's the structural failure mode this amendment corrects.

## Decision

**Reuse the existing `HarnessCapabilityEntry.source`/`remote` contract for E3.B's origin rendering.** Do NOT introduce a parallel `AgentCardLike.origin` field. The agent-card UI component derives its origin badge from the harness entries inside `GatewayAgentCard.capabilities.harnesses[]`, OR from a UI view-model adapter that wraps the existing wire contract.

### Pattern A — Direct consumption (recommended for E3.B)

```typescript
// E3.B acp-agent-card component reads federation origin from existing
// harness entries; no new fields, no new types in ui-components.
function renderOriginBadge(card: GatewayAgentCard | AgentCardLike): TemplateResult {
  const harnesses = card.capabilities?.harnesses ?? [];
  const remoteHarness = harnesses.find(
    (h): h is HarnessCapabilityEntry & { source: "remote" } => h.source === "remote",
  );

  if (remoteHarness === undefined) {
    return html`<span class="origin-badge local">local</span>`;
  }

  return html`
    <span class="origin-badge remote" title=${remoteHarness.remote.gatewayUrl}>
      via ${remoteHarness.remote.childAgentId}
    </span>
  `;
}
```

### Pattern B — UI view-model adapter (when card has mixed-origin harnesses)

Cards with multiple harnesses may have a mix of local and remote (e.g., a gateway federating one harness while running another locally). A view-model adapter projects the wire contract into a UI-friendly shape:

```typescript
// Lives in ui-components (or a derived util package), NOT in the wire contract
export type AgentCardOriginSummary =
  | { kind: "local" }
  | { kind: "remote"; via: HarnessCapabilityEntry["remote"] }
  | { kind: "mixed"; localHarnesses: string[]; remoteHarnesses: NonNullable<HarnessCapabilityEntry["remote"]>[] };

export function summarizeOrigin(card: GatewayAgentCard): AgentCardOriginSummary {
  const harnesses = card.capabilities?.harnesses ?? [];
  const remotes = harnesses.filter(
    (h): h is HarnessCapabilityEntry & { source: "remote" } => h.source === "remote",
  );
  const locals = harnesses.filter((h) => h.source !== "remote");
  if (remotes.length === 0) return { kind: "local" };
  if (locals.length === 0 && remotes.length === 1) {
    return { kind: "remote", via: remotes[0].remote };
  }
  return {
    kind: "mixed",
    localHarnesses: locals.map((h) => h.id),
    remoteHarnesses: remotes.map((h) => h.remote),
  };
}
```

The view-model lives in the UI layer. The wire contract is untouched. Consumers that don't care about origin can ignore harness entries entirely.

## Refutation of the parallel-contract draft

The original draft proposed `AgentCardLike.origin: { kind: "local" } | { kind: "remote"; gatewayId; gatewayUrl }`. Three reasons that draft was wrong:

1. **Replicates an existing contract under a new name.** AJS-23 T2 shipped `HarnessCapabilityEntry.source/remote` for exactly this purpose — discriminating local-vs-remote harness origin. Introducing `AgentCardLike.origin` to do the same thing on a different surface forces consumers to learn two patterns.
2. **Field-by-field divergence.** The draft used `kind` (not `source`), `gatewayId` (not `childAgentId`), missing `hostnameMode` and `coordinatorUrl`. Any later attempt to reconcile would require migrating one to the other, with all the SemVer cost that implies.
3. **Wrong layer.** `AgentCardLike` (in `ui-components`) is a loose, UI-facing type intended for rendering surface, not the federation wire contract. The federation contract lives in `@agents-js/a2a/discovery`. Wire decisions belong in the wire-contract package; UI consumers derive views from it.

## Refutation of `remote: boolean` (preserved from pre-amendment draft)

The original refutations of a `remote: boolean` flag remain valid, but the refutation now targets ANY new boolean addition to either `AgentCardLike` or `HarnessCapabilityEntry`:

1. **Information loss** — boolean collapses "harness on gateway X" vs "harness on gateway Y"; the existing `remote: { gatewayUrl, ... }` envelope retains that information.
2. **Boundary-narrowing-drift risk** — flat-optional fields rot when invariants widen; the existing discriminated union enforces invariants at compile time.
3. **Extensibility** — closed-union (`"local"` | `"remote"`) supports future origin kinds via amendment to `HarnessCapabilityEntry`'s union, not via parallel surfaces.

## Alternatives considered

### Alternative A — Introduce `AgentCardLike.origin` parallel field (pre-amendment draft)

Rejected. See "Refutation of the parallel-contract draft" above.

### Alternative B — Migrate `HarnessCapabilityEntry.source/remote` to `AgentCardLike.origin`

Rejected. The wire contract shipped in AJS-23 T2. Migration would break v1 consumers (gateway-runtime, federation transport, internal-gateway) for no UI-rendering benefit. The wire contract stays; the UI consumes it.

### Alternative C — `remote: boolean` flag on either surface

Rejected. Information loss + extensibility limits per refutation above.

### Alternative D — Document parallel-contract design with explicit bridge

Rejected. Parallel contracts are a maintenance tax — every future change to federation origin requires updates in two places, with drift inevitable. A view-model adapter at the UI layer (Pattern B) provides the same flexibility without two wire contracts.

## Consequences

### Required (acceptance criteria)

- **No type changes to `AgentCardLike`** in `ui-components`. The pre-amendment proposal to add an `origin` field is withdrawn.
- **No type changes to `HarnessCapabilityEntry`** in `@agents-js/a2a/discovery`. The existing v1 wire contract from AJS-23 T2 is the canonical federation-origin shape; this ADR consumes it as-is.
- **`acp-agent-card` E3.B implementation** uses Pattern A directly OR Pattern B view-model:
  - Pattern A: reads `card.capabilities.harnesses[]` and filters for `source === "remote"`
  - Pattern B: imports a `summarizeOrigin(card)` view-model helper that returns `local | remote | mixed` summary
- **No SemVer bump** on `ui-components` (no public API change). No SemVer bump on `@agents-js/a2a` (contract unchanged).
- **Conformance test** for E3.B:
  - acp-agent-card with no harnesses renders local badge
  - acp-agent-card with all-local harnesses renders local badge
  - acp-agent-card with one remote harness renders remote badge using `remote.childAgentId` for short-form and `remote.gatewayUrl` for tooltip
  - acp-agent-card with mixed-origin harnesses renders mixed-state badge (visual TBD by E3.B implementer)
- **Doc update**: `docs/primitives.md` (or wherever federation contract is documented for users) clarifies that `HarnessCapabilityEntry.source/remote` is the canonical origin shape; UI components derive views from it.

### Out of scope (deferred)

- **Future `source` kinds beyond `"local"` | `"remote"`** — added via ADR amendment to `HarnessCapabilityEntry` if needed; the existing union supports additive growth.
- **Origin metadata at the card level** (vs harness level) — currently moot since `GatewayAgentCard` is the card representing a gateway, and gateway-level remote-ness isn't a separate concept from "all of its harnesses are remote". If a card-level distinction becomes meaningful later, that's a follow-up ADR.

### Downstream consumer impact

- **`@agents-js/ui-components`** — E3.B's acp-agent-card consumes the existing harness-entry contract; no new types needed in the UI package.
- **`@agents-js/a2a-client`** — federation transport (slice E1.B) continues to set `source: "remote"` + `remote: {...}` on harness entries it constructs from federated gateways. Unchanged from current behavior.
- **`apps/web-ui`** — federation status panel reads `harnesses[]` for per-harness origin; per-gateway groupings derive from `remote.childAgentId` (gateway identity).
- **Test fixtures** — explicit `source: "remote" + remote: {...}` shape (existing pattern from `packages/a2a` tests).

## Provenance

- **Original surface**: E3-OQ1 in vault planning doc `~/workspace/syncthing/lifestone_ios/workspace/agents-js/docs/research/epic-parallelism-plan-2026-05-18.md` — proposed discriminated `origin` field at AgentCardLike level.
- **Peer review amendment**: cognee-codex's review (Matrix `$jp9bxgYb6_E7u-LUASjxJpKUDKj5v4IGJKoINoswWT8`, 2026-05-18 21:06 PDT) flagged the parallel-contract problem; cognee-claude's resurfacing review at `$rZi3TO1T23YfqwvhB0VK6xZ6kG_9lGKxtr1IgI8fPwY` (22:15 PDT) confirmed the issue was not folded in the initial ADR draft and proposed Pattern A (reuse) or Pattern B (view-model) as resolution paths. This amendment pivots the ADR to reuse the existing contract and documents Pattern B view-model as the recommended bridge for mixed-origin cases.
- **Convention alignment**: the discriminated-union-with-nested-envelope pattern (`source: "remote"; remote: {...}`) mirrors `HarnessCapabilityEntry` exactly, which mirrors AJS-23 T2's federation wire contract.
