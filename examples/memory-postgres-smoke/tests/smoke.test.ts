import { afterAll, describe, expect, test } from "bun:test";
import type { MemoryActor, SaveMemoryInput } from "@agents-js/memory";
import {
  LocalMemoryProvider,
  MemoryAclError,
  type MemoryPolicyGate,
} from "@agents-js/memory-local";
import { PostgresStorage } from "@agents-js/memory-postgres";

const actor: MemoryActor = { kind: "agent", actorId: "smoke-test-agent" };

const denyGlobalGate: MemoryPolicyGate = {
  async evaluate(input) {
    if (input.scope.kind === "global") {
      return { decision: "deny", reason: "global writes require admin" };
    }
    return { decision: "allow" };
  },
};

// Live Postgres is gated on a connection string. POSTGRES_TEST_URL is the
// canonical knob the @agents-js/memory-postgres package tests already use;
// DATABASE_URL is accepted as a fallback for hosts that export the standard
// libpq-style var. No TCP probe — a port check yields no credentials/db and
// would add a nondeterministic timeout; matching the package, env presence
// is the sole gate.
const POSTGRES_URL = process.env.POSTGRES_TEST_URL ?? process.env.DATABASE_URL;
const liveTest = POSTGRES_URL ? test : test.skip;

if (!POSTGRES_URL) {
  // eslint-disable-next-line no-console
  console.log(
    "[memory-postgres-smoke] POSTGRES_TEST_URL/DATABASE_URL not set; " +
      "skipping the live save→update→delete round-trip. The deny-path test " +
      "still runs (it fires before any storage write). Set " +
      "POSTGRES_TEST_URL=postgres://user:pass@host:port/db to exercise the full flow.",
  );
}

describe("memory-postgres-smoke", () => {
  // Intent: the deny path is fully wired end-to-end against the public
  // surface of @agents-js/memory-postgres + @agents-js/memory-local. This
  // proves a real consumer can import PostgresStorage, hand it to
  // LocalMemoryProvider with a gate, and rely on MemoryAclError BEFORE any
  // Postgres connection is opened or write attempted. Runs with no live DB:
  // the `postgres` driver is lazy, so constructing PostgresStorage with a
  // placeholder connection string opens no socket, and the gate denies
  // before the storage seam is ever touched.
  test("policy-gate deny on global scope raises MemoryAclError via the postgres package surface", async () => {
    const storage = new PostgresStorage({
      connectionString: "postgres://smoke:smoke@localhost:5432/smoke",
      schemaName: "memory_postgres_smoke_deny",
    });
    try {
      const provider = new LocalMemoryProvider({ storage, policyGate: denyGlobalGate });
      const input: SaveMemoryInput = {
        scope: { kind: "global" },
        type: "user",
        content: "should be denied",
      };
      await expect(provider.saveMemory(actor, input)).rejects.toBeInstanceOf(MemoryAclError);
    } finally {
      // Close the lazy client so bun:test exits cleanly even though no
      // connection was ever established.
      await storage.close();
    }
  });

  // Intent: the orchestrator + PostgresStorage perform a real round-trip
  // (save → update → delete) against a live Postgres, using an ephemeral
  // schema (dropped on teardown) so concurrent runs don't collide. Skipped
  // when no connection string is present — a clean skip, never a fake pass.
  const liveStorage: PostgresStorage[] = [];

  liveTest(
    "round-trip: save → update → delete via LocalMemoryProvider + PostgresStorage",
    async () => {
      if (POSTGRES_URL === undefined) {
        throw new Error("unreachable: liveTest only runs when POSTGRES_URL is set");
      }
      const schema = `memory_postgres_smoke_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const storage = new PostgresStorage({
        connectionString: POSTGRES_URL,
        schemaName: schema,
      });
      liveStorage.push(storage);
      const provider = new LocalMemoryProvider({ storage, policyGate: denyGlobalGate });

      const saved = await provider.saveMemory(actor, {
        scope: { kind: "agent", agentId: "smoke-test-agent" },
        type: "feedback",
        content: "v1",
      });
      expect(saved.id).toBeDefined();
      expect(saved.revision).toBe("1");

      const updated = await provider.updateMemory(actor, { id: saved.id, content: "v2" });
      expect(updated.id).toBe(saved.id);
      expect(updated.content).toBe("v2");
      expect(updated.revision).toBe("2");

      const fetched = await provider.get(saved.id);
      if (fetched === null) throw new Error("get returned null after update");
      expect(fetched.content).toBe("v2");

      await provider.deleteMemory(actor, { id: saved.id });
      expect(await provider.get(saved.id)).toBeNull();
      await expect(
        provider.updateMemory(actor, { id: saved.id, content: "v3" }),
      ).rejects.toBeInstanceOf(Error);
    },
  );

  afterAll(async () => {
    await Promise.allSettled(
      liveStorage.map(async (storage) => {
        try {
          await storage.__dangerousDropTable();
        } catch {
          // best-effort teardown — matches the package's own test pattern
        }
        await storage.close();
      }),
    );
  });
});
