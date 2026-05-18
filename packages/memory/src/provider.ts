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

/**
 * Provider contract. Consumers implement this against the storage
 * backend of their choice (in-process map, key-value store, document
 * database, etc.) and pass the implementation to the runtime
 * composition root.
 *
 * The interface has two read shapes: substrate-level reads ({@link get},
 * {@link listByScope}) and consumer-facing reads. Substrate reads return
 * raw records without ranking, ACL filtering, or provenance assembly —
 * they exist for federation transport, conformance verification, and
 * admin/audit queries. Consumer-facing reads (ranking, actor-aware ACL
 * filtering, 5-field provenance, format coercion, merge with searchDocs
 * et al.) route exclusively through `@agents-js/tools` `fetchContext` and
 * are NOT part of this interface.
 *
 * v0.6.0 widened the interface with {@link get} + {@link listByScope}
 * after v1's "no query method" doctrine was reversed via ADR 0001 —
 * see `docs/adrs/0001-memory-provider-substrate-read-primitives.md` for
 * the substrate-vs-consumer boundary rationale.
 */
export interface MemoryProvider {
  saveMemory(actor: MemoryActor, input: SaveMemoryInput): Promise<MemoryRecord>;
  updateMemory(actor: MemoryActor, input: UpdateMemoryInput): Promise<MemoryRecord>;
  deleteMemory(actor: MemoryActor, input: DeleteMemoryInput): Promise<void>;
  capabilities(): ProviderCapabilities;

  /**
   * Substrate-level read. Returns the record at `memoryId`, or `null` if
   * no such record exists. ACL is NOT enforced — substrate consumers
   * (federation, conformance, admin) need raw access; consumer-facing
   * reads add ACL at the `fetchContext` layer.
   */
  get(memoryId: string): Promise<MemoryRecord | null>;

  /**
   * Substrate-level scoped listing. Returns up to `limit` records under
   * `scope` plus an opaque pagination cursor. Pass the returned cursor
   * back on the next call to fetch the next page; `cursor === null`
   * indicates no further pages.
   *
   * Ordering within a page is provider-defined but MUST be stable across
   * pages for a fixed input. No ranking, no ACL filtering, no metadata
   * filtering at this level — substrate primitive only.
   */
  listByScope(scope: MemoryScope, cursor: string | null, limit: number): Promise<ListByScopeResult>;
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
