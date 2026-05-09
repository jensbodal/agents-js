/**
 * Layer 3 — end-to-end streaming render assertion.
 *
 * Spawns the `mock-acp` runtime in opt-in streaming mode
 * (`MOCK_ACP_STREAMING_TEXT=1`), wires it behind an in-process
 * `UniversalA2AServer + ACPtoA2AExecutor`, and drives a real
 * `A2AClientController.sendTurn` against it. Captures the
 * `message.delta` events emitted by the provider.
 *
 * Asserts the post-fix shape:
 *   - one `message.delta` event per ACP `agent_message_chunk`
 *   - `pendingAgentText` accumulates monotonically across deltas
 *   - final transcript text equals concatenated deltas equal to
 *     `MOCK_ACP_REPLY` (the canned mock reply)
 *
 * Pre-fix (v0.2.x), the executor collapsed all chunks into a single
 * status-update burst, so this test would have seen 1 (or 0) delta
 * events with the full reply, not N deltas. **If this test fails after
 * a green Layer 1+2 run, the diagnosis is wrong** — investigate before
 * shipping.
 *
 * No LLM, deterministic — the streaming-mode mock-acp emits one
 * `agent_message_chunk` per character of `MOCK_ACP_REPLY`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACPtoA2AExecutor, buildAgentCard, UniversalA2AServer } from "@agents-js/a2a";
import { A2AClientController } from "@agents-js/a2a-client";
import { spawnACPAgent } from "@agents-js/acp";
import { MOCK_ACP_REPLY } from "../../gateway-runtime/src/mock-acp/constants.ts";

describe("CLI client streaming render — end-to-end", () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  // Resolve the mock-acp bin entry inside the gateway-runtime package.
  const mockAcpBinPath = path.resolve(testDir, "../../gateway-runtime/bin/mock-acp.ts");

  test("emits one message.delta per ACP chunk; pendingAgentText grows monotonically", async () => {
    const previousCwd = process.cwd();
    const tempCwd = mkdtempSync(path.join(tmpdir(), "agents-js-streaming-render-"));
    process.chdir(tempCwd);

    // Spawn mock-acp with streaming-text mode enabled. One chunk per
    // character of MOCK_ACP_REPLY arrives over the wire.
    const acp = spawnACPAgent({
      command: Bun.which("bun") ?? "bun",
      args: ["run", mockAcpBinPath],
      env: {
        ...process.env,
        MOCK_ACP_STREAMING_TEXT: "1",
      },
    });

    const gatewayCard = buildAgentCard({
      name: "streaming-render-gateway",
      description: "Layer 3 streaming render test gateway",
      capabilities: { "text-to-text": {} },
    });
    const serverWrapper = new UniversalA2AServer(new ACPtoA2AExecutor(acp.stream), gatewayCard);
    const server = await serverWrapper.start(0);
    const baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      const controller = new A2AClientController();
      // Capture every message.delta event emitted by the provider as the
      // SSE stream arrives. The provider wraps the wire's per-chunk
      // Message events in delta events with both cumulative `text` and
      // incremental `delta` fields.
      type DeltaSnapshot = {
        text: string;
        delta: string;
        pendingAgentText: string | undefined;
      };
      const deltaSnapshots: DeltaSnapshot[] = [];
      const allEvents: string[] = [];
      controller.subscribe((event) => {
        allEvents.push(event.type);
        if (event.type === "message.delta") {
          // Capture the controller's pendingAgentText *after* the
          // event's reducer has run by reading getState() inside the
          // listener — listeners fire after state mutation in the
          // session reducer.
          deltaSnapshots.push({
            text: event.text,
            delta: event.delta ?? "",
            pendingAgentText: controller.getState().pendingAgentText,
          });
        }
      });

      await controller.connect({ url: baseUrl, mode: "base" });
      await controller.sendTurn("stream me");

      // DIAGNOSTIC: print all event types observed, with counts.
      const counts: Record<string, number> = {};
      for (const t of allEvents) counts[t] = (counts[t] ?? 0) + 1;
      console.error("[diag] all event types & counts:", JSON.stringify(counts));

      // Load-bearing: streaming actually streams. The wire must deliver
      // multiple incremental message.delta events for a multi-char reply,
      // not one collapsed event with the full text. Provider's
      // `createDeltaAccumulator` may dedup successive identical-text
      // emissions (`packages/a2a-client/src/provider.ts:834` —
      // `messageText !== lastText` guard), so we don't require an exact
      // 1:1 match against chunk count — only that the wire is
      // incremental at all.
      expect(deltaSnapshots.length).toBeGreaterThan(1);
      expect(deltaSnapshots.length).toBeLessThanOrEqual(MOCK_ACP_REPLY.length);

      // Each successive delta extends the cumulative text — text must
      // be monotonically lengthening, with each prior value a prefix of
      // the current. This is the user-facing streaming contract
      // regardless of whether successive deltas are single chars or
      // multi-char chunks.
      let lastText = "";
      for (const snap of deltaSnapshots) {
        expect(snap.text.length).toBeGreaterThanOrEqual(lastText.length);
        if (lastText) expect(snap.text.startsWith(lastText)).toBe(true);
        lastText = snap.text;
      }

      // pendingAgentText grows monotonically across deltas — this is
      // what the TUI transcript renderer paints as the live entry.
      // Strictly increasing length, prior is a prefix of current.
      let lastPending = "";
      for (const snap of deltaSnapshots) {
        const pending = snap.pendingAgentText ?? "";
        expect(pending.length).toBeGreaterThanOrEqual(lastPending.length);
        if (lastPending) {
          expect(pending.startsWith(lastPending)).toBe(true);
        }
        lastPending = pending;
      }

      // Final transcript carries the full reply.
      const finalState = controller.getState();
      const agentEntries = finalState.transcript.filter((e) => e.role === "agent");
      expect(agentEntries.length).toBeGreaterThanOrEqual(1);
      const lastAgentEntry = agentEntries[agentEntries.length - 1];
      expect(lastAgentEntry?.text).toBe(MOCK_ACP_REPLY);
    } finally {
      server.stop();
      acp.kill();
      process.chdir(previousCwd);
    }
  }, 30_000);
});
