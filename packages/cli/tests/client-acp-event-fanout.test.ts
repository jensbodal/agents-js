/**
 * Layer 3 — end-to-end ACP event fan-out.
 *
 * Spawns the `mock-acp` runtime with the non-text event flags enabled
 * (`MOCK_ACP_THOUGHT_CHUNKS`, `MOCK_ACP_TOOL_CALLS`, `MOCK_ACP_PLAN_UPDATES`,
 * `MOCK_ACP_AVAILABLE_COMMANDS`, `MOCK_ACP_MODE_CHANGES`,
 * `MOCK_ACP_USAGE_UPDATES`), wires it behind an in-process
 * `UniversalA2AServer + ACPtoA2AExecutor`, and drives a real
 * `A2AClientController.sendTurn` against it.
 *
 * Asserts the wire shape for each non-text variant:
 *   - `agent_thought_chunk` → `reasoning.message.chunk` events with delta text
 *   - `tool_call` (in_progress) → `tool_call.start` event
 *   - `tool_call_update` (completed, terminal) → `tool_call.end` with status
 *   - `plan` → `plan.updated` with full `PlanEntry[]` (priority enum preserved)
 *   - `available_commands_update` → `commands.updated` with full
 *     `AvailableCommand[]` (description preserved)
 *   - `current_mode_update` → `mode.changed` with the new modeId
 *   - `usage_update` → `usage.updated` with structured `Cost`
 *     (`{ amount, currency }` preserved end-to-end, NOT widened to number)
 *
 * Locks in the SDK-typed wire surface from #23 — if this test starts
 * receiving plain numbers in `usage.updated.cost` or string priorities
 * stripped from `plan.updated.entries`, that's a regression in the
 * defensive-narrowing-vs-pass-through tradeoff and should be investigated
 * before merge.
 *
 * No LLM, deterministic. The fixture is the mock-acp runtime; each
 * env-flag triggers exactly the SessionUpdate variants documented in
 * its module header.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACPtoA2AExecutor, buildAgentCard, UniversalA2AServer } from "@agents-js/a2a";
import {
  type A2AAvailableCommandsUpdatedEvent,
  A2AClientController,
  type A2AEvent,
  type A2AModeChangedEvent,
  type A2APlanUpdatedEvent,
  type A2AReasoningMessageChunkEvent,
  type A2AToolCallEndEvent,
  type A2AToolCallStartEvent,
  type A2AUsageUpdatedEvent,
} from "@agents-js/a2a-client";
import { spawnACPAgent } from "@agents-js/acp";

describe("CLI client ACP event fan-out — end-to-end", () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const mockAcpBinPath = path.resolve(testDir, "../../gateway-runtime/bin/mock-acp.ts");

  test("translates all non-text ACP variants to typed client events with SDK-shaped payloads", async () => {
    const previousCwd = process.cwd();
    const tempCwd = mkdtempSync(path.join(tmpdir(), "agents-js-acp-fanout-"));

    // Acquired before any throwable setup; nullable so the cleanup
    // block at the bottom can guard each individually. If
    // `spawnACPAgent` throws, `serverWrapper.start` never runs and
    // `server` stays null — same for `acp`. Without this layout an
    // early throw would leak the child process and leave the
    // working directory changed for subsequent tests.
    let acp: ReturnType<typeof spawnACPAgent> | null = null;
    let server: Awaited<ReturnType<UniversalA2AServer["start"]>> | null = null;
    let chdirApplied = false;

    try {
      process.chdir(tempCwd);
      chdirApplied = true;

      // Spawn mock-acp with every non-text flag on. One prompt exercises
      // every wire-kind in a single round-trip — small enough to debug
      // when a single variant regresses.
      acp = spawnACPAgent({
        command: Bun.which("bun") ?? "bun",
        args: ["run", mockAcpBinPath],
        env: {
          ...process.env,
          MOCK_ACP_THOUGHT_CHUNKS: "1",
          MOCK_ACP_TOOL_CALLS: "1",
          MOCK_ACP_PLAN_UPDATES: "1",
          MOCK_ACP_AVAILABLE_COMMANDS: "1",
          MOCK_ACP_MODE_CHANGES: "1",
          MOCK_ACP_USAGE_UPDATES: "1",
        },
      });

      const gatewayCard = buildAgentCard({
        name: "acp-event-fanout-gateway",
        description: "Layer 3 ACP event fan-out test gateway",
        capabilities: { "text-to-text": {}, extensions: [] },
      });
      const serverWrapper = new UniversalA2AServer(new ACPtoA2AExecutor(acp.stream), gatewayCard);
      server = await serverWrapper.start(0);
      const baseUrl = `http://127.0.0.1:${server.port}`;

      const controller = new A2AClientController();
      const observed: A2AEvent[] = [];
      controller.subscribe((event) => {
        observed.push(event);
      });

      await controller.connect({ url: baseUrl });
      await controller.sendTurn("hello", { poll: false });

      // --- thought ---
      const thoughtEvents = observed.filter(
        (e): e is A2AReasoningMessageChunkEvent => e.type === "reasoning.message.chunk",
      );
      expect(thoughtEvents.length).toBeGreaterThanOrEqual(5);
      // Mock emits 5 deltas: "First, ", "I'm ", "thinking ", "about ", "this. "
      const concatenated = thoughtEvents.map((e) => e.delta ?? "").join("");
      expect(concatenated).toContain("First,");
      expect(concatenated).toContain("thinking");
      // Cumulative text is rebuilt by the translator; the last delta's
      // wrapping reasoning event must carry the same messageId so
      // consumers can correlate.
      const messageIds = new Set(thoughtEvents.map((e) => e.messageId));
      expect(messageIds.size).toBe(1);

      // --- tool calls ---
      const startEvents = observed.filter(
        (e): e is A2AToolCallStartEvent => e.type === "tool_call.start",
      );
      const endEvents = observed.filter(
        (e): e is A2AToolCallEndEvent => e.type === "tool_call.end",
      );
      expect(startEvents).toHaveLength(1);
      expect(startEvents[0]?.toolCallName).toBe("Read");
      expect(endEvents).toHaveLength(1);
      // Terminal status from mock = "completed"; the executor's
      // `isTerminalToolCallStatus` gate routes this to tool-call-end.
      expect(endEvents[0]?.status).toBe("completed");
      // Same toolCallId on start and end (the gating doesn't synthesize a
      // new id on terminal transitions).
      expect(endEvents[0]?.toolCallId).toBe(startEvents[0]?.toolCallId);

      // --- plan ---
      const planEvents = observed.filter(
        (e): e is A2APlanUpdatedEvent => e.type === "plan.updated",
      );
      expect(planEvents).toHaveLength(1);
      expect(planEvents[0]?.entries).toHaveLength(3);
      // SDK-typed `priority: PlanEntryPriority` flows through verbatim,
      // not coerced to a number or dropped.
      expect(planEvents[0]?.entries.map((e) => e.priority)).toEqual(["high", "medium", "low"]);
      expect(planEvents[0]?.entries.map((e) => e.status)).toEqual([
        "completed",
        "in_progress",
        "pending",
      ]);

      // --- available commands ---
      const commandEvents = observed.filter(
        (e): e is A2AAvailableCommandsUpdatedEvent => e.type === "commands.updated",
      );
      expect(commandEvents).toHaveLength(1);
      expect(commandEvents[0]?.commands).toEqual([
        { name: "/think", description: "Toggle thinking" },
        { name: "/plan", description: "Switch to plan mode" },
      ]);

      // --- mode ---
      const modeEvents = observed.filter(
        (e): e is A2AModeChangedEvent => e.type === "mode.changed",
      );
      expect(modeEvents).toHaveLength(1);
      expect(modeEvents[0]?.modeId).toBe("execute");

      // --- usage ---
      const usageEvents = observed.filter(
        (e): e is A2AUsageUpdatedEvent => e.type === "usage.updated",
      );
      expect(usageEvents.length).toBeGreaterThanOrEqual(1);
      const lastUsage = usageEvents[usageEvents.length - 1];
      expect(lastUsage?.size).toBe(200_000);
      expect(lastUsage?.used).toBe(12_345);
      // Structured Cost preserved end-to-end — NOT widened to number,
      // NOT dropped. This is the schema-derived-types contract from #23.
      expect(lastUsage?.cost).toEqual({ amount: 0.18, currency: "USD" });
    } finally {
      server?.stop();
      acp?.kill();
      if (chdirApplied) {
        process.chdir(previousCwd);
      }
    }
  }, 30_000);
});
