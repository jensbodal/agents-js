import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ACPSessionController,
  createNodeFileAdapters,
  PermissionEngine,
  PermissionStore,
} from "@agents-js/acp-host";

// The real external mock ACP agent — a JSON-RPC subprocess that speaks the
// ACP protocol over stdio/NDJSON (see tests/mock-acp-agent.cjs). It is spawned
// as a genuine child process here; nothing in this test stubs the controller's
// transport. From this file (examples/acp-runtime-smoke/tests) the repo-root
// `tests/` dir is three levels up.
const MOCK_AGENT = resolve(import.meta.dir, "../../../tests/mock-acp-agent.cjs");

// Real subprocess spawn + ACP handshake is slower than the bun:test 5s default.
const TEST_TIMEOUT_MS = 20_000;

describe("acp-runtime-smoke", () => {
  let controller: ACPSessionController;
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), "acp-runtime-smoke-"));
    controller = new ACPSessionController();
    await controller.start({
      agentConfig: {
        name: "acp-runtime-smoke",
        command: "node",
        args: [MOCK_AGENT],
        env: {},
        authHints: [],
        workspacePolicy: "workspace-root-only",
        // Mirror createGatewayTestServer: the mock resolves `node` from the
        // real PATH, so the spawn must not run under a sandboxed home.
        allowRealHome: true,
      },
      workspacePath,
      fileAdapters: createNodeFileAdapters(workspacePath),
      permissionEngine: new PermissionEngine(),
      permissionStore: new PermissionStore(),
      clientInfo: { name: "acp-runtime-smoke", version: "0.1.0" },
    });
    await controller.setPermissionMode("bypassPermissions");
  });

  afterEach(async () => {
    // Destroy kills the spawned subprocess; without it the child leaks and the
    // test runner can hang on teardown.
    controller.destroy();
    // Remove the temp workspace so repeated runs don't accumulate dirs.
    await rm(workspacePath, { recursive: true, force: true });
  });

  // Intent: prove the complete ACP request-response cycle end-to-end against a
  // real mock ACP subprocess, driven through the public ACPSessionController
  // surface — initialize handshake, session creation, a streamed turn, and a
  // second turn, then prove session state persisted across both turns on two
  // independent layers (the host-side controller and the agent subprocess).
  test(
    "initialize -> session -> streaming turns -> persisted state across the session",
    async () => {
      // start() completed the ACP `initialize` handshake; the agent identified
      // itself via agentInfo. This is the controller observing the real reply.
      expect(controller.getState().status).toBe("ready");
      expect(controller.getState().agentName).toBe("MockAgent");

      // Open an ACP session against the running agent.
      const sessionId = await controller.newSession();
      expect(sessionId).toBe("mock-session-123");
      expect(controller.getState().sessionId).toBe(sessionId);

      // Turn 1: a benign prompt (avoids the mock's auth/elicitation directives).
      // The mock streams its default reply as two distinct agent_message_chunk
      // updates ("Hello from " + "Mock ACP Agent!").
      await controller.sendPrompt([{ type: "text", text: "hello" }]);

      const turn1 = controller.getState().completedTurns.at(-1);
      if (!turn1) throw new Error("expected a completed turn after the first prompt");
      // Streaming proof: more than one chunk arrived. A single-shot response
      // would yield exactly one chunk; the concatenated string alone cannot
      // distinguish streamed from non-streamed.
      expect(turn1.textChunks.length).toBeGreaterThanOrEqual(2);
      expect(turn1.textChunks.join("")).toBe("Hello from Mock ACP Agent!");
      expect(turn1.stopReason).toBe("end_turn");

      // Turn 2: same session, second prompt. The sessionId must not change —
      // controller-side proof that the session persisted across the turn.
      await controller.sendPrompt([{ type: "text", text: "hello again" }]);
      expect(controller.getState().sessionId).toBe(sessionId);
      expect(controller.getState().completedTurns).toHaveLength(2);

      // Subprocess-side proof: the mock increments an in-process promptCount on
      // every real turn and reports it (without incrementing) for the
      // `__PROMPT_COUNT__` diagnostic probe. After two real turns it must read
      // 2 — proving the SAME agent subprocess accumulated state across turns,
      // not a fresh spawn per prompt.
      await controller.sendPrompt([{ type: "text", text: "__PROMPT_COUNT__" }]);
      const probeTurn = controller.getState().completedTurns.at(-1);
      if (!probeTurn) throw new Error("expected a completed turn after the probe prompt");
      expect(probeTurn.textChunks.join("")).toBe("__PROMPT_COUNT__:2");
    },
    TEST_TIMEOUT_MS,
  );
});
