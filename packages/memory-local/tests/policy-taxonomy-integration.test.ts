import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MemoryAclError, type MemoryActor, type MemoryScope } from "@agents-js/memory";
import { LocalMemoryProvider } from "../src/local-memory-provider.ts";
import { createMemoryPolicyV12Gate } from "../src/policy-taxonomy.ts";
import { SqliteStorage } from "../src/sqlite-storage.ts";

/**
 * End-to-end integration: the v1.2 taxonomy gate wired into the real
 * `LocalMemoryProvider` against a `:memory:` sqlite. Pins that each
 * category's decision lifts to the right provider outcome (allow →
 * record persists; ask → `MemoryAclError`; deny → `MemoryAclError`).
 */

const projectActor: MemoryActor = { kind: "agent", actorId: "alice" };
const foreignActor: MemoryActor = { kind: "agent", actorId: "stranger" };
const projectScope: MemoryScope = { kind: "agent", agentId: "alice" };

function projectMatcher(actor: MemoryActor, scope: MemoryScope): boolean {
  if (scope.kind === "agent") return actor.actorId === scope.agentId;
  return false;
}

let storage: SqliteStorage;

afterEach(() => {
  storage?.close();
});

beforeEach(() => {
  storage = new SqliteStorage({ dbPath: ":memory:" });
});

describe("MemoryPolicy v1.2 taxonomy × LocalMemoryProvider — end-to-end", () => {
  // Project actor on a project-scoped save: gate allows; provider
  // persists. Verifies the happy path through the real wire.
  test("project-write by project actor: provider persists the record", async () => {
    const provider = new LocalMemoryProvider({
      storage,
      policyGate: createMemoryPolicyV12Gate({ isProjectActor: projectMatcher }),
    });
    const record = await provider.saveMemory(projectActor, {
      scope: projectScope,
      type: "user-fact",
      content: "alice likes typescript",
    });
    expect(record.id).toBeDefined();
    expect(record.content).toBe("alice likes typescript");
  });

  // Foreign actor on a project-scoped save: gate returns ask; v1
  // provider lifts ask → MemoryAclError. Verifies the ask-as-deny
  // contract holds end-to-end.
  test("project-write by foreign actor: provider raises MemoryAclError (ask treated as deny)", async () => {
    const provider = new LocalMemoryProvider({
      storage,
      policyGate: createMemoryPolicyV12Gate({ isProjectActor: projectMatcher }),
    });
    await expect(
      provider.saveMemory(foreignActor, {
        scope: projectScope,
        type: "user-fact",
        content: "stranger trying to write",
      }),
    ).rejects.toBeInstanceOf(MemoryAclError);
  });

  // Destructive delete with no consent token: ask → MemoryAclError.
  // First seeds a record (via a separate consent-allowed provider) so
  // delete has a target, then attempts the delete against the
  // taxonomy gate without a token.
  test("destructive delete without consent token raises MemoryAclError", async () => {
    const seedProvider = new LocalMemoryProvider({ storage });
    const seeded = await seedProvider.saveMemory(projectActor, {
      scope: projectScope,
      type: "user-fact",
      content: "to be deleted",
    });
    const taxonomyProvider = new LocalMemoryProvider({
      storage,
      policyGate: createMemoryPolicyV12Gate({ isProjectActor: projectMatcher }),
    });
    await expect(
      taxonomyProvider.deleteMemory(projectActor, { id: seeded.id }),
    ).rejects.toBeInstanceOf(MemoryAclError);
  });

  // Destructive delete WITH a valid consent token: gate allows;
  // provider deletes. Verifies the consent token rides through
  // metadata correctly.
  test("destructive delete with valid consent token deletes the record", async () => {
    const seedProvider = new LocalMemoryProvider({ storage });
    const seeded = await seedProvider.saveMemory(projectActor, {
      scope: projectScope,
      type: "user-fact",
      content: "to be deleted with consent",
    });
    const taxonomyProvider = new LocalMemoryProvider({
      storage,
      policyGate: createMemoryPolicyV12Gate({
        isProjectActor: projectMatcher,
        validateConsentToken: (t) => t === "workspace-consent-ok",
      }),
    });
    await expect(
      taxonomyProvider.deleteMemory(projectActor, {
        id: seeded.id,
        policy: { consentToken: "workspace-consent-ok" },
      }),
    ).resolves.toBeUndefined();
    // Confirm storage is empty.
    expect(await storage.getRecord(seeded.id)).toBeUndefined();
  });

  // Destructive global-scope write without consent: ask → ACL error.
  test("destructive save to scope.global without consent raises MemoryAclError", async () => {
    const provider = new LocalMemoryProvider({
      storage,
      policyGate: createMemoryPolicyV12Gate({ isProjectActor: projectMatcher }),
    });
    await expect(
      provider.saveMemory(projectActor, {
        scope: { kind: "global" },
        type: "broadcast-fact",
        content: "everyone read this",
      }),
    ).rejects.toBeInstanceOf(MemoryAclError);
  });

  // Configured type explicitly allow-listed: a non-project actor can
  // save under a configured type without consent because the gate's
  // allow-list opt-in supersedes the project-actor check.
  test("configured-type allow-listed: non-project actor save succeeds", async () => {
    const provider = new LocalMemoryProvider({
      storage,
      policyGate: createMemoryPolicyV12Gate({
        isProjectActor: projectMatcher,
        configuredTypes: { allow: ["openmemory-quick-note"] },
      }),
    });
    const record = await provider.saveMemory(foreignActor, {
      scope: projectScope,
      type: "openmemory-quick-note",
      content: "quick-note from stranger",
    });
    expect(record.content).toBe("quick-note from stranger");
  });
});
