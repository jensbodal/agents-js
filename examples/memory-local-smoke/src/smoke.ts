/**
 * Smoke CLI for @agents-js/memory-local.
 *
 * What this demonstrates:
 *   - LocalMemoryProvider wiring with a real SqliteStorage on a tmpdir
 *     sqlite file and a custom MemoryPolicyGate.
 *   - The policy-gate seam: a `deny` decision lifts to MemoryAclError
 *     BEFORE any storage write.
 *   - A full allow-path round-trip: save → update → delete.
 *
 * Run:  bun run src/smoke.ts
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryActor, SaveMemoryInput } from "@agents-js/memory";
import {
  LocalMemoryProvider,
  MemoryAclError,
  type MemoryPolicyGate,
  SqliteStorage,
} from "@agents-js/memory-local";

const actor: MemoryActor = { kind: "agent", actorId: "smoke-agent" };

// A policy gate that denies any write to global scope; everything else
// is allowed. Models the "no anonymous global writes" posture a real
// host might enforce.
const denyGlobalGate: MemoryPolicyGate = {
  async evaluate(input) {
    if (input.scope.kind === "global") {
      return { decision: "deny", reason: "global scope writes require admin approval" };
    }
    return { decision: "allow" };
  },
};

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "memory-local-smoke-"));
  const dbPath = join(dir, "smoke.sqlite");
  console.log(`[smoke] sqlite db location: ${dbPath}`);

  const storage = new SqliteStorage({ dbPath });
  const provider = new LocalMemoryProvider({ storage, policyGate: denyGlobalGate });

  const denySave: SaveMemoryInput = {
    scope: { kind: "global" },
    type: "user",
    content: "should be denied",
  };
  try {
    await provider.saveMemory(actor, denySave);
    console.log("[smoke] UNEXPECTED: global save was permitted");
  } catch (err) {
    if (err instanceof MemoryAclError) {
      console.log(`[smoke] deny path OK — MemoryAclError raised: ${err.message}`);
    } else {
      throw err;
    }
  }

  const allowSave: SaveMemoryInput = {
    scope: { kind: "agent", agentId: "smoke-agent" },
    type: "feedback",
    content: "agent-scoped write is permitted by policy",
  };
  const saved = await provider.saveMemory(actor, allowSave);
  console.log(`[smoke] saved id=${saved.id} revision=${saved.revision}`);

  const updated = await provider.updateMemory(actor, {
    id: saved.id,
    content: "agent-scoped write, edited",
  });
  console.log(`[smoke] updated id=${updated.id} revision=${updated.revision}`);

  await provider.deleteMemory(actor, { id: saved.id });
  console.log(`[smoke] deleted id=${saved.id}`);

  await storage.close();
}

await main();
