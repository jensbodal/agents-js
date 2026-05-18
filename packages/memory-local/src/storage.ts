import type { MemoryActor, MemoryRecord, MemoryScope } from "@agents-js/memory";

/**
 * Storage seam used by `LocalMemoryProvider`.
 *
 * Public surface: external consumers can implement this interface to
 * back the provider with their own durable storage (e.g. postgres,
 * level, a remote KV) instead of the default sqlite implementation.
 * The bundled `SqliteStorage` is the reference implementation.
 *
 * Shape rules:
 *   - All methods are async (sqlite-backend may sit behind a worker).
 *   - `insertRecord` round-trips the supplied record. The caller (the
 *     provider) owns id generation in v1 — backends MUST accept the
 *     supplied id and SHOULD support generating one as a future option.
 *   - `updateRecord` exposes optimistic concurrency via
 *     `expectedRevision`. Backends return a discriminated union so the
 *     provider can lift a conflict into `MemoryRevisionConflictError`
 *     without the seam knowing the error type.
 *   - `findByIdempotency` MUST scope by `(creatorKind, creatorId, key)`
 *     — never by `key` alone — so two actors' identical keys don't
 *     collide.
 */
export interface Storage {
  insertRecord(record: StoredRecord): Promise<StoredRecord>;
  updateRecord(
    id: string,
    patch: StoredRecordPatch,
    expectedRevision?: string,
  ): Promise<UpdateRecordResult>;
  getRecord(id: string): Promise<StoredRecord | undefined>;
  deleteRecord(id: string): Promise<boolean>;
  findByIdempotency(
    creatorKind: MemoryActor["kind"],
    creatorId: string,
    key: string,
  ): Promise<StoredRecord | undefined>;
  /**
   * Substrate scope listing. Returns up to `limit` records under `scope`
   * plus an opaque pagination cursor. The provider exposes this verbatim
   * through `MemoryProvider.listByScope`; backends own the cursor format
   * (sqlite uses id-as-cursor here, but pg/level/redis MAY use whatever
   * fits their storage). No ACL filter, no ranking — substrate read only.
   */
  listByScope(
    scope: MemoryScope,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: StoredRecord[]; cursor: string | null }>;
  /** Resource teardown. MUST be safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Backend-stored record shape. Extends the public `MemoryRecord` with
 * provider-internal fields (creator provenance, idempotency key) that
 * are not exposed across the `MemoryProvider` boundary.
 */
export interface StoredRecord extends MemoryRecord {
  creator: MemoryActor;
  idempotencyKey?: string;
}

/**
 * Partial update payload accepted by the storage seam. Mirrors the
 * caller-facing `UpdateMemoryInput` semantic: absent fields are
 * untouched, present fields replace.
 */
export interface StoredRecordPatch {
  content?: string;
  metadata?: Record<string, unknown>;
}

export type UpdateRecordResult =
  | { ok: true; record: StoredRecord }
  | { ok: false; current: StoredRecord };
