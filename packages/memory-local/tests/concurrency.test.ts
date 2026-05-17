import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SqliteStorage } from "../src/sqlite-storage.ts";
import type { StoredRecord } from "../src/storage.ts";

/**
 * Concurrency tests for {@link SqliteStorage}.
 *
 * Invariants under test:
 *   - concurrent inserts with no caller-supplied id produce distinct ids
 *     (the default id generator does not collide under interleaving)
 *   - updateRecord with a stale expectedRevision returns
 *     `{ ok: false, current }` — the seam's revision-conflict path
 */

let storage: SqliteStorage;

beforeEach(() => {
  storage = new SqliteStorage({ dbPath: ":memory:" });
});

afterEach(async () => {
  await storage.close();
});

function fixtureRecord(overrides: Partial<StoredRecord> = {}): StoredRecord {
  return {
    id: "",
    scope: { kind: "global" },
    type: "user",
    content: "c",
    metadata: {},
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    revision: "1",
    creator: { kind: "agent", actorId: "agent-A" },
    ...overrides,
  };
}

describe("SqliteStorage — concurrency", () => {
  // Intent: when the caller leaves `id` empty, the seam falls back to
  // its own id generator. Two simultaneous inserts MUST receive
  // distinct ids. The default generator uses a monotonic counter
  // inside a closure, so even within the same millisecond the counter
  // disambiguates. If this test ever fails we have a collision risk
  // for any path that lets the seam generate ids (currently rare in
  // production but supported by the seam's contract).
  test("two simultaneous insertRecord calls with no caller-supplied id produce distinct ids", async () => {
    const inserts = Array.from({ length: 32 }, () =>
      storage.insertRecord(fixtureRecord({ id: "" })),
    );
    const results = await Promise.all(inserts);
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(results.length);
    for (const r of results) {
      expect(r.id.length).toBeGreaterThan(0);
    }
  });

  // Intent: optimistic concurrency. The provider hands the seam an
  // `expectedRevision` token; if it doesn't match the current row,
  // the seam returns `{ ok: false, current }` so the provider can lift
  // the result into a MemoryRevisionConflictError. We seed a row,
  // bump it once via a fresh update, then try to update again with
  // the now-stale revision and confirm the conflict branch fires
  // (carrying the current record).
  test("updateRecord with stale expectedRevision returns { ok: false, current }", async () => {
    const seed = await storage.insertRecord(fixtureRecord({ id: "mem_conflict_1", revision: "1" }));
    expect(seed.revision).toBe("1");

    const firstBump = await storage.updateRecord(seed.id, { content: "bumped once" }, "1");
    expect(firstBump.ok).toBe(true);
    if (firstBump.ok) {
      expect(firstBump.record.revision).toBe("2");
    }

    // Stale: caller still thinks revision is "1".
    const stale = await storage.updateRecord(
      seed.id,
      { content: "trying to bump from stale" },
      "1",
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.current.id).toBe(seed.id);
      expect(stale.current.revision).toBe("2");
      // content was NOT overwritten by the stale attempt
      expect(stale.current.content).toBe("bumped once");
    }
  });

  // Intent: update WITHOUT expectedRevision MUST succeed regardless of
  // current revision — the provider only enforces concurrency when
  // the caller opts in. This pins that the seam does not implicitly
  // enforce it.
  test("updateRecord with undefined expectedRevision succeeds even after a prior bump", async () => {
    const seed = await storage.insertRecord(fixtureRecord({ id: "mem_unguarded", revision: "1" }));
    const firstBump = await storage.updateRecord(seed.id, { content: "v2" }, undefined);
    expect(firstBump.ok).toBe(true);
    const secondBump = await storage.updateRecord(seed.id, { content: "v3" }, undefined);
    expect(secondBump.ok).toBe(true);
    if (secondBump.ok) {
      expect(secondBump.record.content).toBe("v3");
      expect(secondBump.record.revision).toBe("3");
    }
  });
});
