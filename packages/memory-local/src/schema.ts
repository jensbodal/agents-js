import type { Database } from "bun:sqlite";

/**
 * Bumped whenever the on-disk DDL changes incompatibly. The migration
 * function stamps this into `PRAGMA user_version` after applying the
 * DDL, and refuses to open a file whose stored version is newer than
 * this constant (a forward-compat guard against an older binary
 * silently corrupting a database written by a newer build).
 */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * Canonical schema. `CREATE TABLE IF NOT EXISTS` makes the DDL safe to
 * re-run; the migration function still only applies it on a fresh
 * database (user_version = 0) so the per-process cost is one read.
 *
 * The unique index on (creator_kind, creator_id, idempotency_key)
 * implements the seam's idempotency scoping rule — the same key from
 * two different creators MUST coexist; only same-creator+same-key
 * collides. The partial-index `WHERE idempotency_key IS NOT NULL` lets
 * records without a key skip the index entirely.
 */
export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  creator_kind TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  idempotency_key TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_records_idempotency
  ON records(creator_kind, creator_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_records_scope ON records(scope_kind, scope_key);
`;

interface UserVersionRow {
  user_version: number;
}

/**
 * Read `PRAGMA user_version`; if 0, apply {@link SCHEMA_DDL} and stamp
 * `currentVersion`. If already equal, no-op. If greater than
 * `currentVersion`, throw — refuse to open a file written by a newer
 * binary.
 *
 * Stamping uses string interpolation because sqlite's `PRAGMA` syntax
 * does not accept bound parameters. The value is a caller-controlled
 * integer (this module's `CURRENT_SCHEMA_VERSION`), never user input.
 */
export function migrate(db: Database, currentVersion: number): void {
  const row = db.query("PRAGMA user_version").get() as UserVersionRow | null;
  const stored = row?.user_version ?? 0;

  if (stored > currentVersion) {
    throw new Error(
      `memory-local: database schema version ${stored} is newer than supported version ${currentVersion}; refusing to open`,
    );
  }

  if (stored === currentVersion) {
    return;
  }

  // stored === 0 (fresh file). v1 has no migration path from older
  // versions because v1 IS the first version. Future versions will
  // branch on `stored` and apply incremental migration steps before
  // stamping `currentVersion`.
  db.run(SCHEMA_DDL);
  db.run(`PRAGMA user_version = ${currentVersion}`);
}
