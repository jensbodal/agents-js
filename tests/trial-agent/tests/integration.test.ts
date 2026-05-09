/**
 * Real-ACP integration test for the trial agent.
 *
 * Spawns `bun run bin/trial-agent.ts` as a real subprocess, opens an ACP
 * `ClientSideConnection` over its stdio, drives the full handshake +
 * session lifecycle, and asserts that each gate-triggering prompt
 * produces the expected agent_message_chunk text.
 *
 * This is the gate harness referenced in the task spec: it succeeds when
 * the seven D readiness gates either pass or are deferred-as-expected.
 * A real (vs in-process) subprocess is the whole point — it catches
 * stdio/NDJSON/protocol-layer mismatches that an in-process harness would
 * mask.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { spawnACPAgent } from "@agents-js/acp";

const BIN_ENTRY = path.resolve(import.meta.dir, "../bin/trial-agent.ts");
const FIXTURE_WS = path.resolve(import.meta.dir, "fixtures/workspace");
const FIXTURE_HUB = path.resolve(import.meta.dir, "fixtures/hub");
const BUN_BIN = Bun.which("bun") ?? "bun";

interface DriverHandle {
  connection: ClientSideConnection;
  notifications: SessionNotification[];
  close: () => void;
}

interface SpawnOptions {
  /** Extra args to forward to the bin. Used to exercise --hub-root. */
  binArgs?: readonly string[];
  /** Env override; defaults to the env-var path the rest of the suite uses. */
  env?: Record<string, string>;
}

function spawnTrialAgent(options: SpawnOptions = {}): DriverHandle {
  const acp = spawnACPAgent({
    command: BUN_BIN,
    args: ["run", BIN_ENTRY, ...(options.binArgs ?? [])],
    env: options.env ?? {
      TRIAL_AGENT_HUB_ROOT: FIXTURE_HUB,
      TRIAL_AGENT_WORKSPACE: FIXTURE_WS,
    },
  });
  const notifications: SessionNotification[] = [];
  const connection = new ClientSideConnection(
    () => ({
      async sessionUpdate(params) {
        notifications.push(params);
      },
      async requestPermission() {
        // The trial agent never requests permission; keep the typecheck happy
        // with a deny-by-default outcome.
        return { outcome: { outcome: "cancelled" } };
      },
      async writeTextFile() {
        throw new Error("trial-agent should not request fs writes");
      },
      async readTextFile() {
        throw new Error("trial-agent should not request fs reads");
      },
      async createTerminal() {
        throw new Error("trial-agent should not create terminals");
      },
      async killTerminal() {
        return;
      },
      async releaseTerminal() {
        return;
      },
      async terminalOutput() {
        throw new Error("trial-agent should not request terminal output");
      },
      async waitForTerminalExit() {
        throw new Error("trial-agent should not wait on terminals");
      },
    }),
    acp.stream,
  );
  return {
    connection,
    notifications,
    close: () => acp.kill(),
  };
}

async function withTrialAgent<T>(
  fn: (handle: DriverHandle, sessionId: string) => Promise<T>,
): Promise<T> {
  const handle = spawnTrialAgent();
  try {
    await handle.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const newSession = await handle.connection.newSession({
      cwd: FIXTURE_WS,
      mcpServers: [],
    });
    return await fn(handle, newSession.sessionId);
  } finally {
    handle.close();
  }
}

function lastAgentMessageText(notifications: SessionNotification[]): string {
  for (let i = notifications.length - 1; i >= 0; i -= 1) {
    const note = notifications[i];
    const update = note?.update;
    if (
      update &&
      update.sessionUpdate === "agent_message_chunk" &&
      update.content.type === "text"
    ) {
      return update.content.text;
    }
  }
  throw new Error("no agent_message_chunk found in notifications");
}

describe("trial-agent over real ACP wire", () => {
  test("fetchContext prompt returns hub-file source via session/update", async () => {
    await withTrialAgent(async ({ connection, notifications }, sessionId) => {
      const promptResp = await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "fetch context about time estimates" }],
      });
      expect(promptResp.stopReason).toBe("end_turn");
      const text = lastAgentMessageText(notifications);
      expect(text).toContain("fetchContext");
      expect(text).toContain("hub-file");
      expect(text).toContain("[responsible]");
    });
  }, 20000);

  test("findTools prompt returns searchDocs as top match (document-search proof)", async () => {
    await withTrialAgent(async ({ connection, notifications }, sessionId) => {
      await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "/tools search hub for X" }],
      });
      const text = lastAgentMessageText(notifications);
      expect(text).toContain("findTools");
      expect(text).toContain("searchDocs");
    });
  }, 20000);

  test("/gates prompt runs all seven readiness gates and reports outcomes", async () => {
    await withTrialAgent(async ({ connection, notifications }, sessionId) => {
      await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "/gates" }],
      });
      const text = lastAgentMessageText(notifications);
      expect(text).toContain("Readiness gates");
      // All seven gate ids should appear in the report.
      expect(text).toContain("matrix-source-or-deferred");
      expect(text).toContain("workspace-doc-source");
      expect(text).toContain("agent-msg-source-or-deferred");
      expect(text).toContain("stale-source-confidence");
      expect(text).toContain("find-tools-doc-search");
      expect(text).toContain("find-tools-narrow-result");
      expect(text).toContain("fetch-context-three-line-ergonomics");
      // Matrix + agent-msg gates must be DEFER, not silent empty PASS, until
      // those primitives are wired.
      expect(text).toMatch(/\[DEFER\] matrix-source-or-deferred/);
      expect(text).toMatch(/\[DEFER\] agent-msg-source-or-deferred/);
      // The other five gates must PASS.
      expect(text).toMatch(/\[PASS\] workspace-doc-source/);
      expect(text).toMatch(/\[PASS\] stale-source-confidence/);
      expect(text).toMatch(/\[PASS\] find-tools-doc-search/);
      expect(text).toMatch(/\[PASS\] find-tools-narrow-result/);
      expect(text).toMatch(/\[PASS\] fetch-context-three-line-ergonomics/);
    });
  }, 30000);

  test("unknown prompt returns help message", async () => {
    await withTrialAgent(async ({ connection, notifications }, sessionId) => {
      await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });
      const text = lastAgentMessageText(notifications);
      expect(text).toContain("trial-agent");
      expect(text).toContain("Try one of");
    });
  }, 15000);
});
