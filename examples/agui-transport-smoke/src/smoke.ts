/**
 * Smoke CLI for the native AG-UI streaming transport.
 *
 * What this demonstrates:
 *   - Standing up the real gateway stack (ACPSessionController +
 *     HostA2AExecutor + UniversalA2AServer) against the deterministic
 *     mock ACP agent, with the AG-UI endpoint mounted on the server's
 *     `additionalFetch` hook.
 *   - A live `POST /agent` over `Accept: text/event-stream`, decoding the
 *     SSE frames into AG-UI events: RUN_STARTED → interior → RUN_FINISHED.
 *   - The single-active-run gate: a second POST while a run is in flight
 *     is rejected with HTTP 409 + a `Busy` body.
 *
 * Run:  bun run src/smoke.ts
 */

import path from "node:path";
import { EventType } from "@agents-js/agui-types";
import { createAguiFetchHandler } from "@agents-js/host";
import { createGatewayTestServer } from "@agents-js/host/testing";
import { buildRunAgentInput } from "./run-input.ts";
import { readAguiSseFrames } from "./sse-frames.ts";

const mockAgentPath = path.resolve(import.meta.dir, "../../../tests/mock-acp-agent.cjs");

async function postAgent(url: string, prompt: string): Promise<Response> {
  return fetch(`${url}/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(buildRunAgentInput(prompt)),
  });
}

async function main(): Promise<void> {
  const gateway = await createGatewayTestServer({
    acpCommand: "node",
    acpArgs: [mockAgentPath],
    acpEnv: { MOCK_ACP_PROMPT_DELAY_MS: "400" },
    // Mount the native AG-UI endpoint against the factory-owned controller so
    // POST /agent streams a real run on the gateway's own port.
    additionalFetchFactory: ({ controller }) => createAguiFetchHandler({ controller }),
  });
  console.log(`[smoke] gateway up at ${gateway.url}`);

  try {
    // --- Run #1: stream a full run and print its frame types. ---
    const first = await postAgent(gateway.url, "say hello");
    console.log(`[smoke] POST #1 -> HTTP ${first.status}`);
    if (!first.body) throw new Error("POST #1 had no response body");

    const frames = readAguiSseFrames(first.body);

    // Read the opening frame: must be RUN_STARTED.
    const opening = await frames.next();
    const openingType = (opening.value as { type: string } | undefined)?.type;
    console.log(`[smoke] first frame: ${openingType}`);
    if (openingType !== EventType.RUN_STARTED) {
      throw new Error(`expected RUN_STARTED first, got ${openingType}`);
    }

    // --- Run #2: collide mid-run, expect 409 Busy. ---
    const second = await postAgent(gateway.url, "should be rejected");
    console.log(`[smoke] POST #2 (concurrent) -> HTTP ${second.status}`);
    if (second.status !== 409) {
      throw new Error(`expected 409 from concurrent run, got ${second.status}`);
    }
    const busy = (await second.json()) as { error?: string; activeRunId?: string };
    console.log(`[smoke] busy body: error=${busy.error} activeRunId=${busy.activeRunId}`);

    // --- Drain run #1 to its terminal frame. ---
    const seen: string[] = [openingType];
    for await (const event of frames) {
      seen.push((event as { type: string }).type);
    }
    const terminal = seen[seen.length - 1];
    console.log(`[smoke] run #1 frames: ${seen.join(" -> ")}`);
    if (terminal !== EventType.RUN_FINISHED) {
      throw new Error(`expected RUN_FINISHED terminal, got ${terminal}`);
    }
    console.log("[smoke] OK: streaming run + single-active-run gate both verified");
  } finally {
    await gateway.stop();
  }
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});
