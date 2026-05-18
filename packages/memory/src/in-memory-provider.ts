import { MemoryAclError, type MemoryProvider, MemoryRevisionConflictError } from "./provider.ts";
import type {
  DeleteMemoryInput,
  ListByScopeResult,
  MemoryActor,
  MemoryRecord,
  MemoryScope,
  ProviderCapabilities,
  SaveMemoryInput,
  UpdateMemoryInput,
} from "./types.ts";

interface StoredRecord extends MemoryRecord {
  creator: MemoryActor;
  idempotencyKey?: string;
}

export interface InMemoryProviderOptions {
  /** Override clock for deterministic tests. Returns ms since epoch. */
  now?: () => number;
  /** Override id generator for deterministic tests. */
  newId?: () => string;
}

/**
 * Reference provider — all capabilities = true. Lives in the package
 * so the conformance harness has a known-good target. Consumers MAY
 * use it as a test fixture; not intended for production storage.
 */
export class InMemoryProvider implements MemoryProvider {
  private readonly store = new Map<string, StoredRecord>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private idCounter = 0;

  constructor(opts: InMemoryProviderOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.newId = opts.newId ?? (() => `mem_${++this.idCounter}`);
  }

  capabilities(): ProviderCapabilities {
    return { idempotency: true, revisions: true, acl: true };
  }

  async saveMemory(actor: MemoryActor, input: SaveMemoryInput): Promise<MemoryRecord> {
    if (input.idempotencyKey !== undefined) {
      for (const existing of this.store.values()) {
        if (
          existing.idempotencyKey === input.idempotencyKey &&
          existing.creator.kind === actor.kind &&
          existing.creator.actorId === actor.actorId
        ) {
          return toRecord(existing);
        }
      }
    }

    const ts = this.now();
    const record: StoredRecord = {
      id: this.newId(),
      scope: structuredClone(input.scope),
      type: input.type,
      content: input.content,
      metadata: structuredClone(input.metadata ?? {}),
      createdAtMs: ts,
      updatedAtMs: ts,
      revision: "1",
      creator: { kind: actor.kind, actorId: actor.actorId },
      idempotencyKey: input.idempotencyKey,
    };
    this.store.set(record.id, record);
    return toRecord(record);
  }

  async updateMemory(actor: MemoryActor, input: UpdateMemoryInput): Promise<MemoryRecord> {
    const existing = this.store.get(input.id);
    if (!existing) {
      throw new Error(`No memory record with id ${input.id}`);
    }
    this.requireAuthorized(actor, existing);
    if (input.expectedRevision !== undefined && input.expectedRevision !== existing.revision) {
      throw new MemoryRevisionConflictError(existing.id, existing.revision ?? "");
    }

    if (input.content === undefined && input.metadata === undefined) {
      return toRecord(existing);
    }

    const updated: StoredRecord = {
      ...existing,
      content: input.content ?? existing.content,
      metadata: input.metadata !== undefined ? structuredClone(input.metadata) : existing.metadata,
      updatedAtMs: this.now(),
      revision: bumpRevision(existing.revision),
    };
    this.store.set(updated.id, updated);
    return toRecord(updated);
  }

  async deleteMemory(actor: MemoryActor, input: DeleteMemoryInput): Promise<void> {
    const existing = this.store.get(input.id);
    if (!existing) return;
    this.requireAuthorized(actor, existing);
    this.store.delete(input.id);
  }

  async get(memoryId: string): Promise<MemoryRecord | null> {
    const existing = this.store.get(memoryId);
    return existing === undefined ? null : toRecord(existing);
  }

  async listByScope(
    scope: MemoryScope,
    cursor: string | null,
    limit: number,
  ): Promise<ListByScopeResult> {
    // Insertion order is preserved by Map, but for cursor stability we
    // re-derive a deterministic ordering by id. Substrate read primitive:
    // no ACL filter, no ranking, no metadata coercion.
    const matching: StoredRecord[] = [];
    for (const record of this.store.values()) {
      if (scopeEquals(record.scope, scope)) matching.push(record);
    }
    matching.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const startIdx = cursor === null ? 0 : findStartIndex(matching, cursor);
    const page = matching.slice(startIdx, startIdx + limit);
    const nextCursor =
      startIdx + limit < matching.length ? (page[page.length - 1]?.id ?? null) : null;

    return {
      records: page.map(toRecord),
      cursor: nextCursor,
    };
  }

  private requireAuthorized(actor: MemoryActor, record: StoredRecord): void {
    if (actor.kind === record.creator.kind && actor.actorId === record.creator.actorId) {
      return;
    }
    throw new MemoryAclError(actor, record.scope);
  }
}

function toRecord(stored: StoredRecord): MemoryRecord {
  const { creator: _creator, idempotencyKey: _idem, ...record } = stored;
  return {
    ...record,
    scope: structuredClone(record.scope),
    metadata: structuredClone(record.metadata),
  };
}

function bumpRevision(current: string | undefined): string {
  const n = Number.parseInt(current ?? "0", 10);
  return Number.isFinite(n) ? String(n + 1) : "1";
}

function scopeEquals(a: MemoryScope, b: MemoryScope): boolean {
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

/**
 * Given a sorted-by-id list and a cursor (last id of the previous page),
 * return the index of the first record whose id is strictly greater than
 * the cursor. If the cursor is not found or all ids are <=, returns the
 * list length (caller emits an empty page).
 */
function findStartIndex(sorted: StoredRecord[], cursor: string): number {
  for (let i = 0; i < sorted.length; i++) {
    const record = sorted[i];
    if (record !== undefined && record.id > cursor) return i;
  }
  return sorted.length;
}
