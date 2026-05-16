import type {
  DeleteMemoryInput,
  MemoryActor,
  MemoryRecord,
  MemoryScope,
  ProviderCapabilities,
  SaveMemoryInput,
  UpdateMemoryInput,
} from "./types.ts";

/**
 * Provider contract. Consumers implement this against the storage
 * backend of their choice (in-process map, key-value store, document
 * database, etc.) and pass the implementation to the runtime
 * composition root.
 *
 * No query method in v1 — reads route exclusively through
 * `@agents-js/tools` `fetchContext`. This avoids duplicating the
 * 5-field provenance shape that fetchContext already standardizes.
 */
export interface MemoryProvider {
  saveMemory(actor: MemoryActor, input: SaveMemoryInput): Promise<MemoryRecord>;
  updateMemory(actor: MemoryActor, input: UpdateMemoryInput): Promise<MemoryRecord>;
  deleteMemory(actor: MemoryActor, input: DeleteMemoryInput): Promise<void>;
  capabilities(): ProviderCapabilities;
}

/** Thrown by providers when `expectedRevision` doesn't match current. */
export class MemoryRevisionConflictError extends Error {
  override readonly name = "MemoryRevisionConflictError";
  constructor(
    public readonly id: string,
    public readonly currentRevision: string,
  ) {
    super(`Revision conflict on memory id ${id}: current is ${currentRevision}`);
  }
}

/** Thrown by providers when `actor` lacks permission to act on `scope`. */
export class MemoryAclError extends Error {
  override readonly name = "MemoryAclError";
  constructor(
    public readonly actor: MemoryActor,
    public readonly scope: MemoryScope,
  ) {
    super(`Actor ${actor.kind}:${actor.actorId} cannot operate on scope ${JSON.stringify(scope)}`);
  }
}
