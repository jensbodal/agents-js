# ADR 0005 — Memory rehydration consumer surface

**Status**: Accepted (2026-05-27)
**Deciders**: ajs-claude, cognee-claude (peer convergence)
**Affects**: `@agents-js/tools`, `@agents-js/memory`, host-runtime session bootstrap

---

## Context

`@agents-js/tools` ships two read-side surfaces today: `fetchContext` (Shape 1 coordinator over filesystem-backed primitives `searchMemories` + `searchDocs`) and `findTools` (Shape 2 discovery). ADR 0001 widened `@agents-js/memory` with substrate read primitives (`get`, `listByScope`) and explicitly deferred the "how does the consumer surface consume them" question to a follow-up ADR.

Two consumer call sites now need a read path:

1. **LLM-initiated ad-hoc lookup** — already shipped as the MCP `fetchContext` tool. An agent asks a free-text question mid-task; the tool returns ranked snippets with 5-field provenance.
2. **Host-initiated session-start rehydration** — when a fresh runtime starts (no prior conversation context), the host needs to inject recent / relevant agent memory into system-prompt assembly before the model sees its first turn. There is no LLM driving this call — the host runtime decides what to pull and when.

The integration question: do both surfaces share an importable callable, or does the host call `fetchContext` (which today does I/O against `.agents/<name>/*.md` files, not against `@agents-js/memory` providers), or does the host fan out to providers itself through a new coordinator?

cognee-claude reframed the axis from "MCP-tool vs substrate-primitive" to **host-initiated reads vs LLM-initiated reads**. Both surfaces are reads with the same provenance and filtering requirements; they differ only in who initiates. That reframe is the canonical decision frame banked in this ADR.

### Source-check findings (relevant to the decision)

A read of the current code, not paraphrase:

- `fetch-context.ts:46-58` (`fetchContext`) is a thin orchestrator: route via `routeFetchContext`, run primitives in parallel, merge.
- `fetch-context.ts:88-127` (`mergeResults`) is the only ranking/pruning code at the coordinator layer — sort snippets by score desc, slice to limit, prune orphan sources.
- `primitives/search-memories.ts:112-148` walks the local filesystem under `.agents/<name>/` and constructs `Source` records inline at lines 135-142. **It does not read from any `MemoryProvider`.**
- `primitives/search-docs.ts:91-127` mirrors the same structure against `hubRoot`. Provenance is again assembled inline (lines 114-121).
- `router.ts:105-118` (`scoreSnippet`) is the actual relevance kernel — keyword-count over tokenized text. It is already exported.
- Neither package nor any consumer currently performs tag-based filtering. `tags` appears in the codebase only in `trace.ts` (trace metadata) and `conformance.ts` (memory metadata fixture).

This matters because the colloquial framing of "extract the ranking + tag-filtering + provenance-assembly core from `fetchContext`" overstates what is there to extract. The relevance kernel exists (`scoreSnippet`); the merge logic exists; provenance assembly is **per-primitive**, not in the coordinator; tag-filtering is **net-new**, not pre-existing.

## Decision

Introduce a host-importable ranking callable, sibling to (not extracted from) the existing primitives. Initial location: `packages/tools/src/primitives/rank.ts`, exported from `@agents-js/tools` as an internal API. A new package is not justified — the kernel (`scoreSnippet`, `tokenize`) already lives in `@agents-js/tools/router`, and there is no host-vs-tools dependency-direction concern that demands a separate package.

Contract (target, not present-day):

```typescript
export interface RankInput {
  records: MemoryRecord[];
  query?: string;
  tags?: readonly string[];
  limit?: number;
  now?: () => Date;
}

export interface RankedResult {
  snippets: Snippet[];
  sources: Source[];
}

export function rank(input: RankInput): RankedResult;
```

Behavior:

- **Input is `MemoryRecord[]`**, not a filesystem walk. The caller (host runtime, MCP tool wrapper) is responsible for sourcing the records — typically via `MemoryProvider.listByScope` per ADR 0001. The callable is record-shape-agnostic; it does not call providers itself.
- **Tag-filtering** is applied first: when `tags` is non-empty, only records whose `metadata.tags` intersects the requested set survive. When `tags` is omitted or empty, all records pass.
- **Ranking**: when `query` is provided, score each surviving record's `content` via `scoreSnippet`, sort desc, slice to `limit` (default 10).
- **First-session default**: when both `query` and `tags` are absent (the host-runtime session-start case with no topic signal), sort by `createdAtMs` desc and return the most-recent `limit` records. The callable does not silently return zero — empty rehydration is a degenerate state.
- **Limit overflow**: when `limit` exceeds the number of available records after filtering/ranking, return all available records. The callable does not error on under-supply; it returns whatever survived the pipeline.
- **Provenance assembly** is per-record: each surviving record yields one `Source` with `source_type: "memory-provider"` (substrate-read from a `MemoryProvider`, distinguished from `"hub-file"` which is the filesystem `.agents/<name>/*.md` walk). The `SourceType` enum is widened to add `"memory-provider"` as a deliberate enumerated value; `"tool"` would conflate substrate-read provenance with general tool provenance and is rejected as a compromise (per cognee-claude review, cid `cognee-claude-adr-0005-approve-1400z`).

Wiring:

- The existing MCP `fetchContext` tool keeps its current shape externally; internally it continues to coordinate `searchMemories` + `searchDocs` against the filesystem. **It does not gain a provider dependency in this ADR.**
- Host-runtime session-start imports `rank` directly and feeds it records from `MemoryProvider.listByScope`.
- A future ADR (sibling decision, deliberately deferred) decides whether to fold provider-backed records into the MCP `fetchContext` path — i.e. whether the LLM-initiated tool should *also* see provider memory, or stay scoped to filesystem.

## Alternatives considered

### Alternative A — `fetchContext` becomes a coordinator that fans out to `@agents-js/memory` providers

Rejected. Adding provider fanout at the coordinator layer reintroduces the exact provenance-bypass risk ADR 0001 closed off. Each provider would either need to construct `Source` records itself (duplicating per-call-site assembly logic across every backend) or the coordinator would need to lift provenance assembly above the providers (where it does not know enough about backend semantics — e.g. agent-msg's `observed_at` is per-row, sqlite's is the file mtime). Per-primitive provenance is the v1 boundary; a fanout coordinator dissolves it.

### Alternative B — MCP fanout to providers

Rejected. Two failures:
- Local reads pay network coupling (host loops back to itself over MCP just to read local sqlite).
- Per-provider provenance enforcement becomes harder, not easier — provenance is now constructed inside the MCP tool wrapper rather than inside the substrate that owns the data.

### Alternative C — Keep `fetchContext` MCP-only; expose `MemoryProvider.listByScope` directly to host-runtime session-start

Rejected. `listByScope` returns raw records with no ranking, no filtering, no provenance — it is a substrate primitive per ADR 0001. Pushing the ranking + provenance assembly into the host runtime duplicates the logic the MCP tool will eventually need. The whole point of a shared callable is one ranking implementation, two callers.

## Consequences

### Required (acceptance criteria)

- **New module** `packages/tools/src/primitives/rank.ts` exporting `rank(input: RankInput): RankedResult`.
- **Export** from `@agents-js/tools` barrel (`packages/tools/src/index.ts`) — alongside `searchDocs`, `searchMemories`, `scoreSnippet`.
- **Unit tests** covering: tag-filtering with empty / non-empty tags; query-mode ranking parity with current `scoreSnippet`; first-session recency default; limit slicing; empty-input behavior.
- **Host-runtime wiring** (separate slice, but referenced here): session-start bootstrap calls `MemoryProvider.listByScope` for the agent's scope, passes records to `rank`, injects the ranked snippets + provenance into system-prompt assembly.
- **SemVer**: additive minor on `@agents-js/tools` (new exported symbol; existing surfaces unchanged).

### First-session default behavior

When `rank` is called with no `query` and no `tags`, it returns the most-recent `limit` records by `createdAtMs` desc. This is the host-runtime session-start contract: a fresh agent with no topic signal still receives recent memory rather than an empty rehydration. Documented on the callable, not just in this ADR.

### Coupling risk — concrete, not deferred

A clean implementation requires three things, and the "extraction" framing in the original task hides one of them:

1. **The relevance kernel is already separable.** `scoreSnippet` + `tokenize` in `router.ts` are pure functions, already exported. No surgery needed.
2. **Provenance assembly is currently per-primitive, not coordinator-level.** `searchMemories` and `searchDocs` each build their own `Source` records inline. The new `rank` callable cannot "inherit" provenance assembly from `fetchContext` because `fetchContext` never had it — it only merges/prunes. The new callable assembles provenance for the provider-backed-record path itself; the existing filesystem-walk primitives keep their own assembly.
3. **Tag-filtering is net-new.** It is not extracted from existing `fetchContext` logic — there is none. The ADR introduces the predicate.

**Prep-PR shape (if extraction were the model)**: would lift provenance assembly out of `searchMemories`/`searchDocs` into a coordinator-level pass and add a tag-filtering layer the primitives currently lack. **Not chosen** — the sibling-callable model in this ADR avoids the prep PR by leaving the filesystem primitives alone and building the provider-record path independently. Total surgery: one new file, one new export, one new test file.

If a future ADR decides to merge the two paths (filesystem + provider, single coordinator), the prep PR resurfaces. Documenting that future cost here so it is not a surprise then.

### Relevance algorithm — deferred

The current kernel is keyword-count over lowercased alphanumeric tokens (`router.ts:105-118`). Whether session-start rehydration wants the same kernel, or BM25, or cosine-over-embeddings, or pure tag-match-only, is a sibling decision. `rank` takes `query` and `tags` so the contract accommodates strategy swap without callsite changes; the pluggable-strategy ADR will modify `rank`'s internals, not its signature.

### Out of scope

This ADR is **read-side only**.

- **Write-side** (`cognee_bridge` outbox polling → `MemoryProvider.saveMemory`) stays in its existing flow. ADR 0005 does not modify it, does not constrain it, does not change its provenance.
- **Cross-room federation** of memory reads (ADR 0001 §"Out of scope") remains its own decision.
- **Provider-backed records inside the MCP `fetchContext` tool** is deliberately deferred. This ADR exposes the host-runtime caller; the LLM-initiated path keeps its current filesystem scope until a sibling ADR opens the merge question.
- **A pluggable relevance-strategy contract** is its own decision (see "Relevance algorithm — deferred" above).

## Open questions

These did not block the decision; **both are now resolved per cognee-claude review 2026-05-27** (cid `cognee-claude-adr-0005-approve-1400z`). Recorded here for the audit trail:

- **Substrate enumeration for first-session default** — **RESOLVED: MERGE, with dedup-on-content-hash refinement.** Filesystem `.agents/<name>/*.md` is hand-edited anchor memory (baseline notes an agent should remember by default); provider memory is dynamic learning. Different editorial discipline, different write-time, different surfaces. Merging gives anchor + dynamic union. Disambiguation via `Source.source_type` (`"hub-file"` vs `"memory-provider"`). When the same content appears in both surfaces (rare but possible — e.g., a memory promoted from dynamic learning into an anchor file), dedup on content-hash to prevent duplicate snippets in the ranked result. The host-runtime slice that wires `rank` for session-start MUST compose both record sets before calling.
- **`source_type` for provider-backed records** — **RESOLVED: widen the enum with `"memory-provider"`.** `"tool"` would conflate "I read from a substrate provider" with "I read from a general tool surface" — different provenance kinds. Type-driven honest-config beats silent conflation. Behavior section above already reflects this; the enum widening lands in the implementation PR.

## Provenance

- **Decision frame banked**: cognee-claude reframe of "MCP-tool vs substrate-primitive" → "host-initiated reads vs LLM-initiated reads" — `cognee-claude-q1-path2-signoff-0805z`.
- **Event chain**: ajs-claude Q1 critique (`$o4c4iwK_32L6oBNBWchr8kxEZ4uOBgKqCnJ0cUjNDJo`) → cognee-claude reframe → cognee-claude signoff with three additions folded into this ADR (`$FW002WhbQSsctdkvdhATy9N-dkXbxfsuFQyGVn25JVI`) → ADR draft posted for review (`$jDIVbVf61_iaFqOi9U4PyKk4u2bzqFOp5jnHTiUsDt4`) → cognee-claude APPROVE with 2 open-question answers + limit-overflow refinement (`cognee-claude-adr-0005-approve-1400z`).
- **Three additions absorbed from signoff**: first-session recency default (Decision §"First-session default"); write-side explicit out-of-scope (Consequences §"Out of scope"); source-check the extraction coupling concretely (Consequences §"Coupling risk").
- **Three refinements absorbed from APPROVE review**: limit-overflow behavior (Decision §"Limit overflow"); `"memory-provider"` source_type widening (Decision §"Provenance assembly"); MERGE-with-dedup substrate enumeration (Open questions, resolved).
- **Prior ADR referenced**: ADR 0001 (substrate vs consumer read boundary).
