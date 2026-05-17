/**
 * Host-side consumer pilot for @agents-js/memory + @agents-js/memory-local.
 *
 * What this demonstrates:
 *   - The host-runtime consumption pattern: a single LocalMemoryProvider
 *     instance composed once at host startup and serving writes from
 *     three distinct caller principals (agent | human | service).
 *   - The `service` actor kind — non-interactive callers (cron, health
 *     checks, CI pipelines, scheduled jobs) participating in the same
 *     provenance model as interactive callers.
 *   - Per-actor scope pairing: each actor writes into a scope that
 *     matches its identity, mirroring the real host's "principal
 *     drives default scope" pattern.
 *
 * Run:  bun run --cwd examples/host-memory-pilot smoke
 *
 * This is consumption-pattern reference + smoke evidence ONLY. It does
 * NOT close the v1-stable provider gate — that requires a real
 * internal consumer outside `@agents-js/memory*`. The v1-stable gate
 * is tracked separately in Plane.
 */

import type { MemoryActor, MemoryRecord, SaveMemoryInput } from "@agents-js/memory";
import { LocalMemoryProvider, noopPolicyGate, SqliteStorage } from "@agents-js/memory-local";

/** A host typically maintains one provider instance shared across all callers. */
function buildHostProvider(): LocalMemoryProvider {
  return new LocalMemoryProvider({
    storage: new SqliteStorage({ dbPath: ":memory:" }),
    policyGate: noopPolicyGate,
  });
}

/** Compact line writer so the smoke output reads as a trace, not a log dump. */
function trace(actor: MemoryActor, label: string, record: MemoryRecord): void {
  console.log(
    `[smoke] kind=${actor.kind.padEnd(7)} actor=${actor.actorId.padEnd(20)} ${label} id=${record.id} rev=${record.revision}`,
  );
}

async function main(): Promise<void> {
  const provider = buildHostProvider();

  // Three principals a real host expects to receive writes from. The
  // scope each chooses mirrors a sensible default: agent → its own
  // agent scope, human → a global note (operator-broadcast), service
  // → a room scope for the room it acts on behalf of.
  const agent: MemoryActor = { kind: "agent", actorId: "planner-1" };
  const human: MemoryActor = { kind: "human", actorId: "jens" };
  const service: MemoryActor = { kind: "service", actorId: "cron-smoke-1" };

  const inputs: ReadonlyArray<{ actor: MemoryActor; input: SaveMemoryInput }> = [
    {
      actor: agent,
      input: {
        scope: { kind: "agent", agentId: agent.actorId },
        type: "project",
        content: "agent-recorded plan step",
      },
    },
    {
      actor: human,
      input: {
        scope: { kind: "global" },
        type: "feedback",
        content: "human-authored operator note",
      },
    },
    {
      actor: service,
      input: {
        scope: { kind: "room", roomId: "ops-room" },
        type: "reference",
        content: "service-emitted health checkpoint",
      },
    },
  ];

  // Round-trip each: save → update → delete. Demonstrates the same
  // provider handles all three actor kinds uniformly, including the
  // `service` kind added in PR #18 (commit 8e8e4ce6).
  for (const { actor, input } of inputs) {
    const saved = await provider.saveMemory(actor, input);
    trace(actor, "saved   ", saved);

    const updated = await provider.updateMemory(actor, {
      id: saved.id,
      content: `${input.content} (rotated)`,
    });
    trace(actor, "updated ", updated);

    await provider.deleteMemory(actor, { id: saved.id });
    console.log(
      `[smoke] kind=${actor.kind.padEnd(7)} actor=${actor.actorId.padEnd(20)} deleted id=${saved.id}`,
    );
  }

  // Capability probe — a real host caches this once at startup so
  // callers can feature-detect before requesting revision-pinned
  // updates or idempotent writes.
  const caps = await provider.capabilities();
  console.log(
    `[smoke] capabilities: idempotency=${caps.idempotency} revisions=${caps.revisions} acl=${caps.acl}`,
  );
}

await main();
