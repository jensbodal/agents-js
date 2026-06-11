/**
 * Smoke CLI for @agents-js/memory-postgres.
 *
 * What this demonstrates:
 *   - PostgresStorage wiring into LocalMemoryProvider via the public
 *     Storage seam, with a custom MemoryPolicyGate.
 *   - The policy-gate seam: a `deny` decision lifts to MemoryAclError
 *     BEFORE any Postgres write (or even connection) occurs.
 *   - A full allow-path round-trip: save → update → delete, run against a
 *     live Postgres when POSTGRES_TEST_URL/DATABASE_URL is set.
 *
 * Run:  bun run src/smoke.ts
 *   (set POSTGRES_TEST_URL=postgres://user:pass@host:port/db to exercise
 *    the live round-trip; without it, only the deny path runs.)
 */

import type { MemoryActor, SaveMemoryInput } from "@agents-js/memory";
import {
  LocalMemoryProvider,
  MemoryAclError,
  type MemoryPolicyGate,
} from "@agents-js/memory-local";
import { PostgresStorage } from "@agents-js/memory-postgres";

const actor: MemoryActor = { kind: "agent", actorId: "smoke-agent" };

// A policy gate that denies any write to global scope; everything else is
// allowed. Models the "no anonymous global writes" posture a real host
// might enforce.
const denyGlobalGate: MemoryPolicyGate = {
  async evaluate(input) {
    if (input.scope.kind === "global") {
      return { decision: "deny", reason: "global scope writes require admin approval" };
    }
    return { decision: "allow" };
  },
};

const POSTGRES_URL = process.env.POSTGRES_TEST_URL ?? process.env.DATABASE_URL;

async function main(): Promise<void> {
  // Deny path: lazy `postgres` client opens no socket, and the gate denies
  // before the storage seam is touched — so this runs without a live DB.
  const denyStorage = new PostgresStorage({
    connectionString: POSTGRES_URL ?? "postgres://smoke:smoke@localhost:5432/smoke",
    schemaName: "memory_postgres_smoke_deny",
  });
  const denyProvider = new LocalMemoryProvider({
    storage: denyStorage,
    policyGate: denyGlobalGate,
  });
  const denySave: SaveMemoryInput = {
    scope: { kind: "global" },
    type: "user",
    content: "should be denied",
  };
  try {
    await denyProvider.saveMemory(actor, denySave);
    console.log("[smoke] UNEXPECTED: global save was permitted");
  } catch (err) {
    if (err instanceof MemoryAclError) {
      console.log(`[smoke] deny path OK — MemoryAclError raised: ${err.message}`);
    } else {
      throw err;
    }
  } finally {
    await denyStorage.close();
  }

  if (POSTGRES_URL === undefined) {
    console.log(
      "[smoke] POSTGRES_TEST_URL/DATABASE_URL not set; skipping the live " +
        "save → update → delete round-trip. Set POSTGRES_TEST_URL to exercise it.",
    );
    return;
  }

  const schema = `memory_postgres_smoke_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  console.log(`[smoke] using ephemeral schema: ${schema}`);
  const storage = new PostgresStorage({ connectionString: POSTGRES_URL, schemaName: schema });
  const provider = new LocalMemoryProvider({ storage, policyGate: denyGlobalGate });

  try {
    const saved = await provider.saveMemory(actor, {
      scope: { kind: "agent", agentId: "smoke-agent" },
      type: "feedback",
      content: "agent-scoped write is permitted by policy",
    });
    console.log(`[smoke] saved id=${saved.id} revision=${saved.revision}`);

    const updated = await provider.updateMemory(actor, {
      id: saved.id,
      content: "agent-scoped write, edited",
    });
    console.log(`[smoke] updated id=${updated.id} revision=${updated.revision}`);

    await provider.deleteMemory(actor, { id: saved.id });
    console.log(`[smoke] deleted id=${saved.id}`);
  } finally {
    try {
      await storage.__dangerousDropTable();
    } catch {
      // best-effort teardown
    }
    await storage.close();
  }
}

await main();
