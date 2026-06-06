import type { MemoryActor, MemoryScope } from "@agents-js/memory";
import type {
  Storage,
  StoredRecord,
  StoredRecordPatch,
  UpdateRecordResult,
} from "@agents-js/memory-local";
import postgresClient, { type Sql } from "postgres";

export interface PostgresStorageOptions {
  /**
   * Postgres connection string (e.g. `postgres://user:pass@host:5432/db`).
   * Required — no default. Production callers MUST pass a string with
   * appropriate credentials + sslmode for their environment.
   */
  connectionString: string;
  /**
   * Schema/namespace prefix. Default `agents_js_memory`. Tables live as
   * `<schema>.records`; multiple memory stores can share a database by
   * choosing different schemas. The schema is created if absent.
   */
  schemaName?: string;
  /**
   * Id generator used when {@link insertRecord} is called with an
   * empty/missing id. The provider owns id generation in the normal
   * path; this is a fallback to keep the seam usable in isolation
   * tests.
   */
  newId?: () => string;
  /** Override clock for deterministic tests. Returns ms since epoch. */
  now?: () => number;
  /**
   * Postgres client options (max connections, idle_timeout, etc.).
   * Passed through to the underlying `postgres` driver. Default is
   * `{ max: 4 }` — small connection pool appropriate for agent memory
   * workloads.
   */
  clientOptions?: Parameters<typeof postgresClient>[1];
}

interface RecordRow {
  id: string;
  scope_kind: string;
  scope_key: string;
  type: string;
  content: string;
  metadata_json: Record<string, unknown>;
  created_at_ms: string; // BIGINT serialized as string by `postgres` client
  updated_at_ms: string;
  revision: number;
  creator_kind: string;
  creator_id: string;
  idempotency_key: string | null;
}

interface EncodedScope {
  kind: "agent" | "room" | "global";
  key: string;
}

/**
 * PostgreSQL-backed {@link Storage} implementation. Plugs into
 * {@link LocalMemoryProvider} via the public Storage seam to back
 * agent memory with durable Postgres storage instead of local sqlite.
 *
 * Substrate read primitives (`listByScope`) use cursor-based pagination
 * (`id > $cursor`) rather than `OFFSET` to remain efficient at scale —
 * Postgres btree indexes on `(scope_kind, scope_key, id)` make the
 * cursor scan O(log n + page size) regardless of how deep the cursor
 * has traveled.
 *
 * Schema lives in a caller-chosen namespace (`schemaName`, default
 * `agents_js_memory`) so multiple memory stores can coexist in one
 * database. The schema is created lazily on construction if absent.
 *
 * Connection pooling is delegated to the underlying `postgres` client;
 * default pool size is 4 (appropriate for memory-store workloads which
 * are bursty but not high-concurrency).
 */
export class PostgresStorage implements Storage {
  private readonly sql: Sql;
  private readonly schemaName: string;
  private readonly newId: () => string;
  private readonly now: () => number;
  private closed = false;
  private migrated = false;

  constructor(options: PostgresStorageOptions) {
    if (!options.connectionString) {
      throw new Error("PostgresStorage: connectionString is required");
    }
    this.schemaName = options.schemaName ?? "agents_js_memory";
    if (!/^[a-z_][a-z0-9_]*$/i.test(this.schemaName)) {
      // Schema name is interpolated into DDL (postgres does not accept
      // bound parameters for schema/table identifiers). Reject anything
      // that isn't a plain identifier to prevent injection.
      throw new Error(
        `PostgresStorage: schemaName must match /^[a-z_][a-z0-9_]*$/i; got ${JSON.stringify(this.schemaName)}`,
      );
    }
    this.sql = postgresClient(options.connectionString, {
      max: 4,
      ...options.clientOptions,
    });
    this.newId = options.newId ?? defaultIdGen();
    this.now = options.now ?? (() => Date.now());
  }

  async insertRecord(record: StoredRecord): Promise<StoredRecord> {
    this.assertOpen();
    await this.ensureMigrated();
    const id = record.id && record.id.length > 0 ? record.id : this.newId();
    const scope = encodeScope(record.scope);
    const revision = parseRevision(record.revision) ?? 1;
    const metadataJson = record.metadata ?? {};

    await this.sql`
      INSERT INTO ${this.sql(this.schemaName)}.records (
        id, scope_kind, scope_key, type, content, metadata_json,
        created_at_ms, updated_at_ms, revision, creator_kind, creator_id, idempotency_key
      ) VALUES (
        ${id}, ${scope.kind}, ${scope.key}, ${record.type}, ${record.content}, ${this.sql.json(metadataJson as Parameters<typeof this.sql.json>[0])},
        ${record.createdAtMs}, ${record.updatedAtMs}, ${revision},
        ${record.creator.kind}, ${record.creator.actorId},
        ${record.idempotencyKey ?? null}
      )
    `;

    return { ...record, id, revision: String(revision) };
  }

  async updateRecord(
    id: string,
    patch: StoredRecordPatch,
    expectedRevision?: string,
  ): Promise<UpdateRecordResult> {
    this.assertOpen();
    await this.ensureMigrated();
    const existing = await this.fetchRowById(id);
    if (existing === undefined) {
      // No existing record — the provider treats this as a not-found
      // condition. Return ok:false with no current to signal the gap.
      throw new Error(`PostgresStorage.updateRecord: id ${id} not found`);
    }
    const currentRecord = rowToStored(existing);
    if (expectedRevision !== undefined && expectedRevision !== currentRecord.revision) {
      return { ok: false, current: currentRecord };
    }

    const nextRevision = (parseRevision(currentRecord.revision) ?? 1) + 1;
    const newContent = patch.content ?? currentRecord.content;
    const newMetadata = patch.metadata ?? currentRecord.metadata ?? {};
    const updatedAt = this.now();

    await this.sql`
      UPDATE ${this.sql(this.schemaName)}.records
      SET content = ${newContent},
          metadata_json = ${this.sql.json(newMetadata as Parameters<typeof this.sql.json>[0])},
          updated_at_ms = ${updatedAt},
          revision = ${nextRevision}
      WHERE id = ${id}
    `;

    return {
      ok: true,
      record: {
        ...currentRecord,
        content: newContent,
        metadata: newMetadata,
        updatedAtMs: updatedAt,
        revision: String(nextRevision),
      },
    };
  }

  async getRecord(id: string): Promise<StoredRecord | undefined> {
    this.assertOpen();
    await this.ensureMigrated();
    const row = await this.fetchRowById(id);
    return row === undefined ? undefined : rowToStored(row);
  }

  async deleteRecord(id: string): Promise<boolean> {
    this.assertOpen();
    await this.ensureMigrated();
    const result = await this.sql`
      DELETE FROM ${this.sql(this.schemaName)}.records
      WHERE id = ${id}
    `;
    // The `postgres` client returns the affected-row count on the
    // result; `result.count` is the canonical accessor.
    return result.count > 0;
  }

  async findByIdempotency(
    creatorKind: MemoryActor["kind"],
    creatorId: string,
    key: string,
  ): Promise<StoredRecord | undefined> {
    this.assertOpen();
    await this.ensureMigrated();
    const rows = (await this.sql`
      SELECT * FROM ${this.sql(this.schemaName)}.records
      WHERE creator_kind = ${creatorKind}
        AND creator_id = ${creatorId}
        AND idempotency_key = ${key}
      LIMIT 1
    `) as unknown as RecordRow[];
    const row = rows[0];
    if (row === undefined) return undefined;
    return rowToStored(row);
  }

  async listByScope(
    scope: MemoryScope,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: StoredRecord[]; cursor: string | null }> {
    this.assertOpen();
    await this.ensureMigrated();
    if (limit <= 0) return { records: [], cursor: null };

    const encoded = encodeScope(scope);
    // Over-fetch by 1 to determine hasNext without a second round-trip.
    const overFetch = limit + 1;

    const rows =
      cursor === null
        ? ((await this.sql`
          SELECT * FROM ${this.sql(this.schemaName)}.records
          WHERE scope_kind = ${encoded.kind} AND scope_key = ${encoded.key}
          ORDER BY id ASC
          LIMIT ${overFetch}
        `) as unknown as RecordRow[])
        : ((await this.sql`
          SELECT * FROM ${this.sql(this.schemaName)}.records
          WHERE scope_kind = ${encoded.kind}
            AND scope_key = ${encoded.key}
            AND id > ${cursor}
          ORDER BY id ASC
          LIMIT ${overFetch}
        `) as unknown as RecordRow[]);

    const hasNext = rows.length > limit;
    const page = hasNext ? rows.slice(0, limit) : rows;
    const records = page.map(rowToStored);
    const lastRecord = records[records.length - 1];
    const nextCursor = hasNext && lastRecord !== undefined ? lastRecord.id : null;
    return { records, cursor: nextCursor };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.sql.end({ timeout: 5 });
  }

  /**
   * Drop the records table. Test-only escape hatch — production code
   * MUST NOT call this. Provided so test setUp/tearDown can isolate
   * runs without leaking state across suites.
   */
  async __dangerousDropTable(): Promise<void> {
    this.assertOpen();
    await this.sql`DROP TABLE IF EXISTS ${this.sql(this.schemaName)}.records`;
    this.migrated = false;
  }

  private async ensureMigrated(): Promise<void> {
    if (this.migrated) return;
    // CREATE SCHEMA IF NOT EXISTS is idempotent; safe to run on every
    // construction. Same with CREATE TABLE IF NOT EXISTS — though the
    // `migrated` flag short-circuits the round-trip after the first call.
    await this.sql`CREATE SCHEMA IF NOT EXISTS ${this.sql(this.schemaName)}`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS ${this.sql(this.schemaName)}.records (
        id TEXT PRIMARY KEY,
        scope_kind TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at_ms BIGINT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        revision INTEGER NOT NULL,
        creator_kind TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        idempotency_key TEXT
      )
    `;
    await this.sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_records_idempotency
        ON ${this.sql(this.schemaName)}.records (creator_kind, creator_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_records_scope_id
        ON ${this.sql(this.schemaName)}.records (scope_kind, scope_key, id)
    `;
    this.migrated = true;
  }

  private async fetchRowById(id: string): Promise<RecordRow | undefined> {
    const rows = (await this.sql`
      SELECT * FROM ${this.sql(this.schemaName)}.records
      WHERE id = ${id}
      LIMIT 1
    `) as unknown as RecordRow[];
    return rows.length === 0 ? undefined : rows[0];
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("PostgresStorage: already closed");
    }
  }
}

function encodeScope(scope: MemoryScope): EncodedScope {
  switch (scope.kind) {
    case "agent":
      return { kind: "agent", key: scope.agentId };
    case "room":
      return { kind: "room", key: scope.roomId };
    case "global":
      return { kind: "global", key: "" };
    default: {
      // Exhaustiveness sentinel: if `MemoryScope` ever widens (a new
      // `kind` lands in `@agents-js/memory`), TypeScript flags this
      // assignment at compile time rather than silently dropping the
      // new kind through this encoder. Per ajs-claude review feedback
      // on PR #34 (gitea comment 1151).
      const _exhaustive: never = scope;
      throw new Error(`encodeScope: unreachable scope kind on ${JSON.stringify(_exhaustive)}`);
    }
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
      throw new Error(`PostgresStorage: unknown scope kind ${JSON.stringify(kind)} in stored row`);
  }
}

const KNOWN_ACTOR_KINDS = new Set<MemoryActor["kind"]>(["agent", "human", "service"]);

function decodeCreator(kind: string, actorId: string): MemoryActor {
  if (!KNOWN_ACTOR_KINDS.has(kind as MemoryActor["kind"])) {
    throw new Error(`PostgresStorage: unknown creator kind ${JSON.stringify(kind)} in stored row`);
  }
  return { kind: kind as MemoryActor["kind"], actorId };
}

function rowToStored(row: RecordRow): StoredRecord {
  return {
    id: row.id,
    scope: decodeScope(row.scope_kind, row.scope_key),
    type: row.type,
    content: row.content,
    metadata: row.metadata_json ?? {},
    createdAtMs:
      typeof row.created_at_ms === "string" ? Number(row.created_at_ms) : row.created_at_ms,
    updatedAtMs:
      typeof row.updated_at_ms === "string" ? Number(row.updated_at_ms) : row.updated_at_ms,
    revision: String(row.revision),
    creator: decodeCreator(row.creator_kind, row.creator_id),
    ...(row.idempotency_key !== null ? { idempotencyKey: row.idempotency_key } : {}),
  };
}

function parseRevision(revision: string | undefined): number | undefined {
  if (revision === undefined) return undefined;
  const n = Number.parseInt(revision, 10);
  return Number.isFinite(n) ? n : undefined;
}

function defaultIdGen(): () => string {
  let n = 0;
  return () => `pg-default-${++n}`;
}
