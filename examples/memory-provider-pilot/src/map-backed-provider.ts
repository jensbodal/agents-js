/**
 * MapBackedProvider — a from-scratch consumer implementation of
 * `MemoryProvider`. Functionally equivalent to the package's reference
 * `InMemoryProvider`, but written fresh against the *published* surface
 * to validate the consumer experience.
 *
 * IMPORTS — strictly through the package entry, no `../../packages/memory/src/...`
 * reach-through. The whole point of this pilot is to confirm that a real
 * external consumer can build a provider with only what `@agents-js/memory`
 * exports.
 *
 * Ergonomics findings (captured live as I wrote this):
 *
 *   1. (positive) Both error classes export as values from the main entry —
 *      `throw new MemoryAclError(...)` and `throw new MemoryRevisionConflictError(...)`
 *      compile without a separate `import type`. Good.
 *
 *   2. (notable) The no-op update contract — `updateMemory(actor, { id })`
 *      with no `content` and no `metadata` is documented as a cheap
 *      "authorization-gated read-back" that does NOT bump revision or
 *      updatedAtMs. That behavior is NOT discoverable from the
 *      `UpdateMemoryInput` TYPE (both fields are just `?:`); a fresh
 *      implementer would only learn the contract by reading
 *      `UpdateMemoryInput.content`'s JSDoc on the canonical types.
 *      The conformance test for "mutable fields don't leak" relies on
 *      this no-op behavior, so a naive implementer who treats no-op as
 *      "bump anyway" will pass that test but violate the contract in
 *      ways their users will eventually notice.
 *
 *   3. (positive) `ProviderCapabilities` requires all three booleans
 *      (`idempotency`, `revisions`, `acl`). No optional flags, no
 *      enums. A provider that supports none of them just returns
 *      `{ idempotency: false, revisions: false, acl: false }` —
 *      ergonomic enough.
 *
 *   4. (minor) `MemoryRecord.revision` is `string | undefined` rather
 *      than a discriminated union keyed off capabilities. A provider
 *      advertising `revisions: true` could still return `undefined`
 *      without a type error. The contract is "present iff capabilities
 *      say so" but the type doesn't enforce it. Not a bug — just a
 *      sharper type would be more self-documenting.
 *
 *   5. (notable) Returned records must be defensively cloned. The
 *      conformance suite explicitly tests that mutating a returned
 *      record's `metadata` or `scope` does not leak into provider
 *      state. There's no helper exported for this — every consumer
 *      provider has to remember to `structuredClone` on the way out
 *      (and on the way in, for `input.scope` / `input.metadata`). A
 *      `cloneRecord(record): MemoryRecord` helper from the package
 *      would prevent a whole class of subtle bugs in downstream
 *      providers. The README / a provider-author guide should at
 *      least call this out explicitly.
 *
 *   6. (positive) `deleteMemory` returns `Promise<void>` — no need to
 *      decide on a return shape for "did it actually exist". The
 *      contract is "idempotent delete, no signal". Simple.
 *
 *   7. (minor) The contract for "no record with this id" on update is
 *      "throw" but the error class is unspecified — the reference uses
 *      a plain `Error(...)`. The conformance suite asserts
 *      `rejects.toBeInstanceOf(Error)`, which any throw satisfies. A
 *      dedicated `MemoryNotFoundError` exported from the package would
 *      let consumers handle it distinctly from `MemoryAclError` /
 *      `MemoryRevisionConflictError`.
 */

import type {
  DeleteMemoryInput,
  ListByScopeResult,
  MemoryActor,
  MemoryRecord,
  MemoryScope,
  ProviderCapabilities,
  SaveMemoryInput,
  UpdateMemoryInput,
} from "@agents-js/memory";
import {
  MemoryAclError,
  type MemoryProvider,
  MemoryRevisionConflictError,
} from "@agents-js/memory";

interface Stored {
  record: MemoryRecord;
  creator: MemoryActor;
  idempotencyKey: string | undefined;
}

export class MapBackedProvider implements MemoryProvider {
  private readonly entries = new Map<string, Stored>();
  private seq = 0;

  capabilities(): ProviderCapabilities {
    return { idempotency: true, revisions: true, acl: true };
  }

  async saveMemory(actor: MemoryActor, input: SaveMemoryInput): Promise<MemoryRecord> {
    if (input.idempotencyKey !== undefined) {
      for (const entry of this.entries.values()) {
        if (
          entry.idempotencyKey === input.idempotencyKey &&
          entry.creator.kind === actor.kind &&
          entry.creator.actorId === actor.actorId
        ) {
          return cloneRecord(entry.record);
        }
      }
    }

    const ts = Date.now();
    const record: MemoryRecord = {
      id: `map_${++this.seq}`,
      scope: structuredClone(input.scope),
      type: input.type,
      content: input.content,
      metadata: structuredClone(input.metadata ?? {}),
      createdAtMs: ts,
      updatedAtMs: ts,
      revision: "1",
    };
    this.entries.set(record.id, {
      record,
      creator: { kind: actor.kind, actorId: actor.actorId },
      idempotencyKey: input.idempotencyKey,
    });
    return cloneRecord(record);
  }

  async updateMemory(actor: MemoryActor, input: UpdateMemoryInput): Promise<MemoryRecord> {
    const entry = this.entries.get(input.id);
    if (!entry) {
      throw new Error(`MapBackedProvider: no record with id ${input.id}`);
    }
    this.assertAuthorized(actor, entry);

    if (input.expectedRevision !== undefined && input.expectedRevision !== entry.record.revision) {
      throw new MemoryRevisionConflictError(entry.record.id, entry.record.revision ?? "");
    }

    // No-op update: caller did not provide content or metadata, so return
    // current state without bumping revision or updatedAtMs. See finding #3
    // in the module header — this contract is *type-invisible*, you only
    // learn it from JSDoc.
    if (input.content === undefined && input.metadata === undefined) {
      return cloneRecord(entry.record);
    }

    const next: MemoryRecord = {
      ...entry.record,
      content: input.content ?? entry.record.content,
      metadata:
        input.metadata !== undefined ? structuredClone(input.metadata) : entry.record.metadata,
      updatedAtMs: Date.now(),
      revision: String(Number.parseInt(entry.record.revision ?? "0", 10) + 1),
    };
    entry.record = next;
    return cloneRecord(next);
  }

  async deleteMemory(actor: MemoryActor, input: DeleteMemoryInput): Promise<void> {
    const entry = this.entries.get(input.id);
    if (!entry) return;
    this.assertAuthorized(actor, entry);
    this.entries.delete(input.id);
  }

  async get(memoryId: string): Promise<MemoryRecord | null> {
    const entry = this.entries.get(memoryId);
    return entry === undefined ? null : cloneRecord(entry.record);
  }

  async listByScope(
    scope: MemoryScope,
    cursor: string | null,
    limit: number,
  ): Promise<ListByScopeResult> {
    // Substrate read primitive (ADR 0001). No ranking, no ACL, no
    // metadata filtering — that's consumer-layer concerns.
    const matching: MemoryRecord[] = [];
    for (const entry of this.entries.values()) {
      if (this.scopeEquals(entry.record.scope, scope)) matching.push(entry.record);
    }
    matching.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const startIdx = cursor === null ? 0 : matching.findIndex((r) => r.id > cursor);
    const effectiveStart = startIdx < 0 ? matching.length : startIdx;
    const page = matching.slice(effectiveStart, effectiveStart + limit);
    const nextCursor =
      effectiveStart + limit < matching.length ? (page[page.length - 1]?.id ?? null) : null;
    return {
      records: page.map(cloneRecord),
      cursor: nextCursor,
    };
  }

  private scopeEquals(a: MemoryScope, b: MemoryScope): boolean {
    if (a.kind !== b.kind) return false;
    switch (a.kind) {
      case "agent":
        return a.agentId === (b as { kind: "agent"; agentId: string }).agentId;
      case "room":
        return a.roomId === (b as { kind: "room"; roomId: string }).roomId;
      case "global":
        return true;
    }
  }

  private assertAuthorized(actor: MemoryActor, entry: Stored): void {
    if (actor.kind === entry.creator.kind && actor.actorId === entry.creator.actorId) return;
    // Clone scope: MemoryAclError stores it by reference, and a caller
    // who catches the error and mutates `error.scope` would otherwise
    // reach into provider state.
    throw new MemoryAclError(actor, structuredClone(entry.record.scope));
  }
}

function cloneRecord(record: MemoryRecord): MemoryRecord {
  return {
    ...record,
    scope: structuredClone(record.scope),
    metadata: structuredClone(record.metadata),
  };
}
