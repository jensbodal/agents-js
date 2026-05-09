/**
 * Unit tests for the mock-acp runtime over a real ACP wire.
 *
 * Spawns `bun run bin/mock-acp.ts` as a subprocess, drives initialize +
 * session/new + session/prompt, and asserts the expected protocol responses.
 * Models the trial-agent integration test pattern.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { spawnACPAgent } from "@agents-js/acp";
import { MOCK_ACP_REPLY } from "../src/mock-acp/constants.ts";

const BIN_ENTRY = path.resolve(import.meta.dir, "../bin/mock-acp.ts");
const BUN_BIN = Bun.which("bun") ?? "bun";

interface DriverHandle {
  connection: ClientSideConnection;
  notifications: SessionNotification[];
  close: () => void;
}

function spawnMockAcp(): DriverHandle {
  const acp = spawnACPAgent({
    command: BUN_BIN,
    args: ["run", BIN_ENTRY],
  });
  const notifications: SessionNotification[] = [];
  const connection = new ClientSideConnection(
    () => ({
      async sessionUpdate(params) {
        notifications.push(params);
      },
      async requestPermission() {
        return { outcome: { outcome: "cancelled" } };
      },
      async writeTextFile() {
        throw new Error("mock-acp should not request fs writes");
      },
      async readTextFile() {
        throw new Error("mock-acp should not request fs reads");
      },
      async createTerminal() {
        throw new Error("mock-acp should not create terminals");
      },
      async killTerminal() {
        return;
      },
      async releaseTerminal() {
        return;
      },
      async terminalOutput() {
        throw new Error("mock-acp should not request terminal output");
      },
      async waitForTerminalExit() {
        throw new Error("mock-acp should not wait on terminals");
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

function lastChunkText(notifications: SessionNotification[]): string {
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

describe("mock-acp over real ACP wire", () => {
  test("initialize returns protocolVersion + agentCapabilities.image=true", async () => {
    const { connection, close } = spawnMockAcp();
    try {
      const resp = await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      expect(resp.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(resp.agentInfo?.name).toBe("mock-acp");
      expect(
        (resp.agentCapabilities as { promptCapabilities?: { image?: boolean } })?.promptCapabilities
          ?.image,
      ).toBe(true);
    } finally {
      close();
    }
  }, 10000);

  test("session/new returns a sessionId", async () => {
    const { connection, close } = spawnMockAcp();
    try {
      await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const resp = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
      expect(typeof resp.sessionId).toBe("string");
      expect(resp.sessionId.length).toBeGreaterThan(0);
    } finally {
      close();
    }
  }, 10000);

  test("session/prompt emits agent_message_chunk then stopReason:end_turn", async () => {
    const { connection, notifications, close } = spawnMockAcp();
    try {
      await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
      const promptResp = await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "Hello" }],
      });
      expect(promptResp.stopReason).toBe("end_turn");
      expect(lastChunkText(notifications)).toBe(MOCK_ACP_REPLY);
    } finally {
      close();
    }
  }, 15000);

  test("two consecutive prompts in one session both reply with non-empty text", async () => {
    const { connection, notifications, close } = spawnMockAcp();
    try {
      await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });

      await connection.prompt({ sessionId, prompt: [{ type: "text", text: "Hello" }] });
      const firstText = lastChunkText(notifications);
      expect(firstText.trim().length).toBeGreaterThan(0);

      await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: "What did I say?" }],
      });
      const secondText = lastChunkText(notifications);
      expect(secondText.trim().length).toBeGreaterThan(0);
    } finally {
      close();
    }
  }, 20000);
});
