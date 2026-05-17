import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION, migrate } from "../src/schema.ts";
import { SqliteStorage } from "../src/sqlite-storage.ts";

/**
 * Migration tests for {@link SqliteStorage}.
 *
 * Invariants under test:
 *   - opening a fresh file stamps `PRAGMA user_version = CURRENT_SCHEMA_VERSION`
 *   - opening a file already at the current version is a no-op (no DDL re-run)
 *   - opening a file at a newer version throws — the binary refuses to
 *     touch a database it doesn't understand
 */

interface UserVersionRow {
  user_version: number;
}

function readUserVersion(dbPath: string): number {
  const probe = new Database(dbPath);
  try {
    const row = probe.query("PRAGMA user_version").get() as UserVersionRow | null;
    return row?.user_version ?? 0;
  } finally {
    probe.close();
  }
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "memory-local-migration-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("SqliteStorage — migration", () => {
  // Intent: the migration function MUST stamp the current schema
  // version into a fresh file so a subsequent open knows the DDL has
  // already been applied. Without the stamp, the second open would
  // re-run the DDL (currently idempotent, but future migrations won't
  // be) and we'd lose the version guard entirely.
  test("opens an empty file and stamps user_version = CURRENT_SCHEMA_VERSION", async () => {
    const dbPath = join(tmp, "fresh.sqlite");
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
    const storage = new SqliteStorage({ dbPath });
    await storage.close();
    expect(readUserVersion(dbPath)).toBe(CURRENT_SCHEMA_VERSION);
  });

  // Intent: a second open against the same file must be a no-op for
  // the DDL path. We verify by re-opening and confirming user_version
  // is still exactly CURRENT_SCHEMA_VERSION (the migrate function's
  // "already at current" branch returns without re-stamping).
  test("opens a file already at user_version = CURRENT_SCHEMA_VERSION without changing it", async () => {
    const dbPath = join(tmp, "already-stamped.sqlite");
    const first = new SqliteStorage({ dbPath });
    await first.close();
    const stampedOnce = readUserVersion(dbPath);

    const second = new SqliteStorage({ dbPath });
    await second.close();
    const stampedTwice = readUserVersion(dbPath);

    expect(stampedOnce).toBe(CURRENT_SCHEMA_VERSION);
    expect(stampedTwice).toBe(CURRENT_SCHEMA_VERSION);
  });

  // Intent: a database stamped with a version newer than this binary
  // supports MUST cause the constructor to throw. Otherwise an old
  // build could silently overwrite/corrupt data written by a newer
  // build. We forge a future-version file by stamping user_version = 99
  // on an empty sqlite file, then assert that constructing the
  // storage against it throws.
  test("rejects opening a file with user_version > CURRENT_SCHEMA_VERSION", async () => {
    const dbPath = join(tmp, "future.sqlite");
    const seed = new Database(dbPath);
    seed.run("PRAGMA user_version = 99");
    seed.close();

    expect(() => new SqliteStorage({ dbPath })).toThrow(/newer than supported version/);
  });

  // Intent: migrate() is reachable directly (it's a documented module
  // export). The direct-call path must behave identically to the
  // SqliteStorage constructor's invocation. This pins that the
  // function is unit-testable without going through the class.
  test("migrate() called directly on a fresh database stamps user_version", () => {
    const dbPath = join(tmp, "direct.sqlite");
    const db = new Database(dbPath);
    try {
      migrate(db, CURRENT_SCHEMA_VERSION);
      const row = db.query("PRAGMA user_version").get() as UserVersionRow | null;
      expect(row?.user_version).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});
