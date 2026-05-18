# ADR 0001 — Memory provider substrate read primitives

**Status**: Accepted (2026-05-18)
**Deciders**: ajs-claude, cognee-claude (peer convergence)
**Affects**: `@agents-js/memory`, `@agents-js/memory-local`, `@agents-js/memory/testing`

---

## Context

The `MemoryProvider` v1 contract (shipped in `packages/memory/src/provider.ts`) was deliberately narrowed to **save/update/delete + capabilities** with no read methods. The in-file doctrine reads:

> No query method in v1 — reads route exclusively through `@agents-js/tools` `fetchContext`. This avoids duplicating the 5-field provenance shape that fetchContext already standardizes.

Three downstream forcing functions have surfaced gaps in this narrow surface:

1. **Conformance verification weakness** — `runProviderConformanceTests` (`packages/memory/src/conformance.ts`) verifies state via mutation return values only. There is no independent read path that confirms "after save → storage actually persisted the record." A provider that returned a correctly-shaped record from `saveMemory` while silently dropping the write would pass conformance today.
2. **Cross-room memory federation** (Wave 2 slice E2.5) — federation transport needs cursored listing across hops at substrate layer. If reads only exist in `tools/fetchContext`, federation has to wrap a consumer-facing tool rather than a substrate primitive, inverting the abstraction.
3. **Storage indexing** — backends like Postgres (slice E2.1) expose btree/GIN indexes on `(scope, creator_kind, creator_id)`. A read-less provider interface wastes those indexes; consumer-layer ranking cannot leverage scope-cursored listing efficiently.

This ADR documents the reversal of the v1 doctrine — explicitly, not silently — and locks the boundary that distinguishes substrate reads (which the provider gains) from consumer reads (which remain in `tools/fetchContext`).

## Decision

Widen the `MemoryProvider` interface with two substrate read primitives:

```typescript
export interface MemoryProvider {
  saveMemory(actor: MemoryActor, input: SaveMemoryInput): Promise<MemoryRecord>;
  updateMemory(actor: MemoryActor, input: UpdateMemoryInput): Promise<MemoryRecord>;
  deleteMemory(actor: MemoryActor, input: DeleteMemoryInput): Promise<void>;
  capabilities(): ProviderCapabilities;

  // New in v0.6.0:
  get(memoryId: string): Promise<MemoryRecord | null>;
  listByScope(
    scope: MemoryScope,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: MemoryRecord[]; cursor: string | null }>;
}
```

**Constraints**:

- `get` and `listByScope` are **substrate read primitives**, not query methods. They return raw records; consumer-facing ranking, ACL filtering, format coercion, and provenance assembly remain in `tools/fetchContext` exclusively.
- `cursor` is an **opaque string** chosen by the provider. Postgres may encode `id > ?`-style cursors; sqlite may encode `OFFSET`; redis may encode SCAN positions. Callers treat it as a black-box token.
- `listByScope` does NOT filter by actor permissions. ACL filtering happens at the consumer layer (`fetchContext`) where actor context is available.
- `get` returns `null` for unknown IDs; ACL is NOT enforced at this level (provider-level get is for substrate use — federation transport, conformance verification, admin queries).

## Refutation of the v1 "avoid provenance duplication" rationale

The original v1 doctrine conflated two distinct read paths:

1. **Substrate reads** — federation transport, conformance verification, admin/audit queries. These move raw records. Provenance assembly is per-consumer, per-retrieval — it is not a property of the storage record.
2. **Consumer reads** — agent-facing retrieval with ranking, ACL filtering, format coercion. These need the 5-field provenance shape; v1 correctly puts them in `fetchContext`.

The hybrid adds (1) without touching (2). No provenance duplication occurs because provenance was never a property of the storage layer in the first place. The v1 ban on "query" was directed at ranking/relevance/search semantics; raw scope-cursored reads are substrate operations, not queries in that sense.

## Alternatives considered

### Alternative A — keep v1 narrow; route conformance + federation through `fetchContext`

Rejected. Conformance harness routing through `fetchContext` would couple storage tests to consumer-layer policy code (ranking, ACL filtering, provenance). Federation transport wrapping `fetchContext` would invert the abstraction: substrate transport depends on consumer-facing tool surface.

### Alternative B — add `get`/`listByScope` as test-only provider hooks (not public)

Rejected. Test-only hooks become leaky abstractions: federation transport (slice E2.5) is not "test-only" and would need the same read surface. A test-only hook plus a federation-only hook ends up as two parallel surfaces doing the same thing.

### Alternative C — add a richer query method (filter by type, time range, creator)

Rejected. Widens the surface beyond what substrate consumers need. Filtering by type/time/creator is consumer-policy territory; it belongs in `fetchContext` (which composes against `listByScope` for the substrate read, then applies filters/ranking above). Keeping the provider surface to exactly two read methods preserves the "storage primitive, not query engine" boundary.

## Consequences

### Required (acceptance criteria)

- **SemVer minor bump** on `@agents-js/memory`: `0.5.1` → `0.6.0` (additive interface widening; existing implementations gain two new methods but their save/update/delete contracts are unchanged).
- **In-file doctrine update** at `packages/memory/src/provider.ts:11-21`: rewrite the doc comment to reflect the substrate-vs-consumer boundary instead of the now-superseded "no query method in v1" framing.
- **Conformance harness strengthening** (HARD AC): `runProviderConformanceTests` adds "after save → `provider.get(id)` confirms record matches" verification across the existing 17 conformance tests. Catches the "save returned record but storage silently dropped it" failure mode.
- **`@agents-js/memory-local` implementation** of `get` + `listByScope` over the existing `Storage` interface. SQLite backend uses standard `SELECT … WHERE id = ?` for `get` and `SELECT … WHERE scope_json = ? ORDER BY id LIMIT ? OFFSET ?` (or equivalent) for `listByScope`.
- **Type exports** from `@agents-js/memory` barrel: existing types unchanged; `listByScope` return type (`{ records: MemoryRecord[]; cursor: string | null }`) exported alongside.

### Out of scope (deferred to follow-up ADRs)

- **`fetchContext` integration** (Epic 2 slice E2.2) — consuming `provider.listByScope` from the tool layer is a separate slice with its own ADR if the integration surfaces new contract questions.
- **Cross-room federation** (E2.5) — federation transport wraps the provider; the wrapping shape is a separate design decision.
- **Skills-as-memory** (E2.3) — adapter pattern atop the read surface; out of scope here.

### Downstream consumer impact

- **`agent-msg/src/memory-provider.ts`** (dot-cognee `AgentMsgMemoryProvider`) gains the two new methods. The agent-msg sqlite backend already has the underlying read capability; surfacing it through the public interface is mechanical.
- **`examples/host-memory-dogfood/`** smoke test unchanged (it tests save/update/delete only).
- **Future providers** (slice E2.1 `@agents-js/memory-postgres`) implement `get` + `listByScope` against their native indexes from day one — the conformance suite is the contract.

## Provenance

- **Surfaced**: peer convergence between cognee-claude (E2-OQ1 hybrid proposal) and ajs-claude (structural callout on v1 doctrine reversal), 2026-05-18.
- **Locked**: 6 AC items converged in Matrix coordination room (`#Cognee Agent Collaboration`) 2026-05-18 18:55-19:02 PDT; documented in vault planning doc `~/workspace/syncthing/lifestone_ios/workspace/agents-js/docs/research/epic-parallelism-plan-2026-05-18.md` under the E2-OQ1 section.
- **First ADR in `agents-js`**: this document establishes the `docs/adrs/` convention at version 0001. Future ADRs follow the same template (Context / Decision / Refutation / Alternatives / Consequences / Provenance).
