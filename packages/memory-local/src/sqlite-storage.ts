import { Database } from "bun:sqlite";
import type { MemoryActor, MemoryScope } from "@agents-js/memory";
import { cloneRecord } from "./clone.ts";
import { CURRENT_SCHEMA_VERSION, migrate } from "./schema.ts";
import type { Storage, StoredRecord, StoredRecordPatch, UpdateRecordResult } from "./storage.ts";

export interface SqliteStorageOptions {
  /**
   * Path to the sqlite database file. Default `:memory:`. Production
   * callers should pass `~/.agents-js/memory/local.sqlite` (or a
   * caller-chosen on-disk location) so records survive restart.
   */
  dbPath?: string;
  /**
   * Id generator used when {@link insertRecord} is called with an
   * empty/missing id. The provider owns id generation in the normal
   * path; this is a fallback to keep the seam usable in isolation
   * tests.
   */
  newId?: () => string;
  /** Override clock for deterministic tests. Returns ms since epoch. */
  now?: () => number;
}

interface RecordRow {
  id: string;
  scope_kind: string;
  scope_key: string;
  type: string;
  content: string;
  metadata_json: string;
  created_at_ms: number;
  updated_at_ms: number;
  revision: number;
  creator_kind: string;
  creator_id: string;
  idempotency_key: string | null;
}

/**
 * sqlite-backed {@link Storage} impl. Uses `bun:sqlite` (a runtime
 * built-in; no npm dependency). WAL is enabled so concurrent readers
 * never block a writer, and `synchronous = NORMAL` trades a small
 * crash-window for ~3x faster commits — acceptable for a local agent
 * memory store, where rebuilding a single dropped write is cheaper than
 * paying full-fsync on every save.
 */
export class SqliteStorage implements Storage {
  private readonly db: Database;
  private readonly newId: () => string;
  private readonly now: () => number;
  private closed = false;

  constructor(options: SqliteStorageOptions = {}) {
    const path = options.dbPath ?? ":memory:";
    this.db = new Database(path);
    // WAL is a no-op for `:memory:` but the pragma still succeeds —
    // bun:sqlite reports `memory` as the journal_mode in that case.
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA foreign_keys = ON");

    migrate(this.db, CURRENT_SCHEMA_VERSION);

    this.newId = options.newId ?? defaultIdGen();
    this.now = options.now ?? (() => Date.now());
  }

  async insertRecord(record: StoredRecord): Promise<StoredRecord> {
    this.assertOpen();
    const id = record.id && record.id.length > 0 ? record.id : this.newId();
    const scope = encodeScope(record.scope);
    const revision = parseRevision(record.revision) ?? 1;
    const metadataJson = JSON.stringify(record.metadata ?? {});

    this.db
      .query(
        `INSERT INTO records (
          id, scope_kind, scope_key, type, content, metadata_json,
          created_at_ms, updated_at_ms, revision, creator_kind, creator_id, idempotency_key
        ) VALUES (
          $id, $scope_kind, $scope_key, $type, $content, $metadata_json,
          $created_at_ms, $updated_at_ms, $revision, $creator_kind, $creator_id, $idempotency_key
        )`,
      )
      .run({
        $id: id,
        $scope_kind: scope.kind,
        $scope_key: scope.key,
        $type: record.type,
        $content: record.content,
        $metadata_json: metadataJson,
        $created_at_ms: record.createdAtMs,
        $updated_at_ms: record.updatedAtMs,
        $revision: revision,
        $creator_kind: record.creator.kind,
        $creator_id: record.creator.actorId,
        $idempotency_key: record.idempotencyKey ?? null,
      });

    const persisted: StoredRecord = {
      ...cloneRecord(record),
      id,
      revision: String(revision),
    };
    return persisted;
  }

  async updateRecord(
    id: string,
    patch: StoredRecordPatch,
    expectedRevision?: string,
  ): Promise<UpdateRecordResult> {
    this.assertOpen();
    const existing = this.selectById(id);
    if (existing === undefined) {
      // The seam's contract: updateRecord on a missing id is a conflict
      // path. The provider decides whether to surface as not-found or
      // revision-conflict; here we synthesize a stub "current" with
      // revision 0 so the seam's discriminated union stays well-formed.
      // The provider is expected to pre-check existence.
      return {
        ok: false,
        current: {
          id,
          scope: { kind: "global" },
          type: "user",
          content: "",
          metadata: {},
          createdAtMs: 0,
          updatedAtMs: 0,
          revision: "0",
          creator: { kind: "agent", actorId: "" },
        },
      };
    }

    if (expectedRevision !== undefined && expectedRevision !== existing.revision) {
      return { ok: false, current: cloneRecord(existing) };
    }

    const nextContent = patch.content !== undefined ? patch.content : existing.content;
    const nextMetadata = patch.metadata !== undefined ? patch.metadata : existing.metadata;
    const isNoop = patch.content === undefined && patch.metadata === undefined;

    if (isNoop) {
      // Per MemoryProvider contract (memory/types.ts): no-op update
      // does not advance revision or updatedAtMs.
      return { ok: true, record: cloneRecord(existing) };
    }

    const nextRevision = (parseRevision(existing.revision) ?? 0) + 1;
    const nextUpdatedAt = this.now();

    this.db
      .query(
        `UPDATE records
         SET content = $content,
             metadata_json = $metadata_json,
             updated_at_ms = $updated_at_ms,
             revision = $revision
         WHERE id = $id`,
      )
      .run({
        $id: id,
        $content: nextContent,
        $metadata_json: JSON.stringify(nextMetadata ?? {}),
        $updated_at_ms: nextUpdatedAt,
        $revision: nextRevision,
      });

    const updated: StoredRecord = {
      ...existing,
      content: nextContent,
      metadata: cloneRecord(nextMetadata ?? {}),
      updatedAtMs: nextUpdatedAt,
      revision: String(nextRevision),
    };
    return { ok: true, record: updated };
  }

  async getRecord(id: string): Promise<StoredRecord | undefined> {
    this.assertOpen();
    const found = this.selectById(id);
    return found === undefined ? undefined : cloneRecord(found);
  }

  async deleteRecord(id: string): Promise<boolean> {
    this.assertOpen();
    const result = this.db.query("DELETE FROM records WHERE id = $id").run({ $id: id });
    // bun:sqlite returns { changes, lastInsertRowid }. Booleanize.
    return result.changes > 0;
  }

  async listByScope(
    scope: MemoryScope,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: StoredRecord[]; cursor: string | null }> {
    this.assertOpen();
    if (limit <= 0) return { records: [], cursor: null };

    const encoded = encodeScope(scope);
    // Cursor is the last-seen id from the previous page; fetch ids
    // strictly greater. We over-fetch by one record to determine whether
    // a next page exists without a second round-trip.
    const overFetch = limit + 1;
    const cursorClause = cursor === null ? "" : "AND id > $cursor";
    const rows = this.db
      .query(
        `SELECT * FROM records
         WHERE scope_kind = $scope_kind AND scope_key = $scope_key
           ${cursorClause}
         ORDER BY id ASC
         LIMIT $limit`,
      )
      .all(
        cursor === null
          ? {
              $scope_kind: encoded.kind,
              $scope_key: encoded.key,
              $limit: overFetch,
            }
          : {
              $scope_kind: encoded.kind,
              $scope_key: encoded.key,
              $cursor: cursor,
              $limit: overFetch,
            },
      ) as RecordRow[];

    const hasNext = rows.length > limit;
    const page = hasNext ? rows.slice(0, limit) : rows;
    const records = page.map(rowToRecord);
    const lastRecord = records[records.length - 1];
    const nextCursor = hasNext && lastRecord !== undefined ? lastRecord.id : null;
    return { records, cursor: nextCursor };
  }

  async findByIdempotency(
    creatorKind: MemoryActor["kind"],
    creatorId: string,
    key: string,
  ): Promise<StoredRecord | undefined> {
    this.assertOpen();
    const row = this.db
      .query(
        `SELECT * FROM records
         WHERE creator_kind = $creator_kind
           AND creator_id = $creator_id
           AND idempotency_key = $key`,
      )
      .get({
        $creator_kind: creatorKind,
        $creator_id: creatorId,
        $key: key,
      }) as RecordRow | null;
    if (row === null) return undefined;
    return rowToRecord(row);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** Internal: synchronous row fetch. */
  private selectById(id: string): StoredRecord | undefined {
    const row = this.db
      .query("SELECT * FROM records WHERE id = $id")
      .get({ $id: id }) as RecordRow | null;
    if (row === null) return undefined;
    return rowToRecord(row);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("memory-local: SqliteStorage is closed");
    }
  }
}

interface EncodedScope {
  kind: string;
  key: string;
}

function encodeScope(scope: MemoryScope): EncodedScope {
  switch (scope.kind) {
    case "agent":
      return { kind: "agent", key: scope.agentId };
    case "room":
      return { kind: "room", key: scope.roomId };
    case "global":
      return { kind: "global", key: "" };
  }
}

function decodeScope(kind: string, key: string): MemoryScope {
  switch (kind) {
    case "agent":
      return { kind: "agent", agentId: key };
    case "room":
      return { kind: "room", roomId: key };
    case "global":
      return { kind: "global" };
    default:
      throw new Error(`memory-local: unknown scope kind '${kind}' in stored row`);
  }
}

function decodeCreator(kind: string, actorId: string): MemoryActor {
  if (kind !== "agent" && kind !== "human" && kind !== "service") {
    throw new Error(`memory-local: unknown creator kind '${kind}' in stored row`);
  }
  return { kind, actorId };
}

function rowToRecord(row: RecordRow): StoredRecord {
  const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
  const record: StoredRecord = {
    id: row.id,
    scope: decodeScope(row.scope_kind, row.scope_key),
    type: row.type,
    content: row.content,
    metadata,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    revision: String(row.revision),
    creator: decodeCreator(row.creator_kind, row.creator_id),
  };
  if (row.idempotency_key !== null) {
    record.idempotencyKey = row.idempotency_key;
  }
  return record;
}

function parseRevision(revision: string | undefined): number | undefined {
  if (revision === undefined) return undefined;
  const n = Number.parseInt(revision, 10);
  return Number.isFinite(n) ? n : undefined;
}

function defaultIdGen(): () => string {
  let counter = 0;
  return () => `mem_${Date.now().toString(36)}_${(++counter).toString(36)}`;
}
