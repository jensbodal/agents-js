import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorage } from "../src/sqlite-storage.ts";
import type { StoredRecord } from "../src/storage.ts";

/**
 * Durability tests for {@link SqliteStorage}.
 *
 * Invariant under test: writes persist across a close/re-open cycle at
 * the same on-disk path, AND the journal mode is WAL so concurrent
 * readers do not block writers in production deployments.
 */

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "memory-local-durability-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function fixtureRecord(overrides: Partial<StoredRecord> = {}): StoredRecord {
  return {
    id: "mem_durable_1",
    scope: { kind: "global" },
    type: "user",
    content: "hello durable world",
    metadata: { source: "test" },
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    revision: "1",
    creator: { kind: "agent", actorId: "agent-A" },
    idempotencyKey: "k1",
    ...overrides,
  };
}

describe("SqliteStorage — durability", () => {
  // Intent: the whole point of an on-disk backend is that records
  // survive process restart. We write through one instance, close it,
  // open a fresh instance at the same path, and read the same row back.
  // If this test fails the package has lost its core value prop.
  test("records persist across SqliteStorage re-open at the same dbPath", async () => {
    const dbPath = join(tmp, "local.sqlite");

    const writer = new SqliteStorage({ dbPath });
    const inserted = await writer.insertRecord(fixtureRecord());
    await writer.close();

    const reader = new SqliteStorage({ dbPath });
    const reread = await reader.getRecord(inserted.id);
    expect(reread).toBeDefined();
    expect(reread?.id).toBe(inserted.id);
    expect(reread?.content).toBe("hello durable world");
    expect(reread?.metadata).toEqual({ source: "test" });
    expect(reread?.scope).toEqual({ kind: "global" });
    expect(reread?.creator).toEqual({ kind: "agent", actorId: "agent-A" });
    expect(reread?.idempotencyKey).toBe("k1");
    expect(reread?.revision).toBe("1");
    await reader.close();
  });

  // Intent: `decodeCreator` is the read-boundary narrowing point from
  // raw `creator_kind: string` back into the `MemoryActor.kind` union.
  // When the union widens, every narrowing point has to widen with it;
  // otherwise a record written with the new kind round-trips through
  // insert but throws on the read after re-open. This pins the contract
  // for `"service"` specifically because that's the kind whose absence
  // from decodeCreator was the actual ship-blocker.
  test("service-kind creator persists across SqliteStorage re-open at the same dbPath", async () => {
    const dbPath = join(tmp, "service-actor.sqlite");

    const writer = new SqliteStorage({ dbPath });
    const inserted = await writer.insertRecord(
      fixtureRecord({
        id: "mem_service_1",
        creator: { kind: "service", actorId: "cron-smoke-1" },
      }),
    );
    await writer.close();

    const reader = new SqliteStorage({ dbPath });
    const reread = await reader.getRecord(inserted.id);
    expect(reread?.creator).toEqual({ kind: "service", actorId: "cron-smoke-1" });

    // Update path also goes through rowToRecord → decodeCreator, so
    // exercise it explicitly — this is the failure mode codex's gate
    // surfaced: the insert succeeds, but the post-reopen update throws.
    const updated = await reader.updateRecord(inserted.id, { content: "rotated" });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.record.creator).toEqual({ kind: "service", actorId: "cron-smoke-1" });
    }
    await reader.close();
  });

  // Intent: WAL mode is what makes concurrent reads non-blocking against
  // an active writer. The constructor sets `PRAGMA journal_mode = WAL`
  // and we verify the database reports it back. (For `:memory:`
  // databases bun:sqlite returns `memory` for journal_mode, so we use
  // an on-disk path to make the assertion meaningful.)
  test("WAL mode is enabled after construction on an on-disk database", async () => {
    const dbPath = join(tmp, "wal.sqlite");
    const storage = new SqliteStorage({ dbPath });
    try {
      // Reach into the same file with a sibling handle to read the
      // pragma without exposing the private db handle on SqliteStorage.
      const probe = new Database(dbPath);
      try {
        const row = probe.query("PRAGMA journal_mode").get() as { journal_mode: string } | null;
        expect(row?.journal_mode?.toLowerCase()).toBe("wal");
      } finally {
        probe.close();
      }
    } finally {
      await storage.close();
    }
  });
});
