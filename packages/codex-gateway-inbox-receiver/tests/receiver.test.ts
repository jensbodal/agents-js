import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileCursorStore,
  type GatewayInboxClient,
  type GetMessagesResult,
} from "@agents-js/gateway-inbox-runtime";
import { deliverRow, runCodexGatewayInboxReceiver } from "../src/receiver.ts";

function client(): GatewayInboxClient & { sends: Array<{ target: string; body: string }> } {
  const sends: Array<{ target: string; body: string }> = [];
  return {
    sends,
    async getMessages(): Promise<GetMessagesResult> {
      return { ok: true, identity: "codex", messages: [] };
    },
    async sendMessage(args) {
      sends.push({ target: args.target, body: args.body });
      return { ok: true };
    },
    async close() {},
  };
}

const logger = { log() {}, warn() {}, error() {} };

describe("deliverRow", () => {
  test("does not auto-reply when Matrix row has no routable target", async () => {
    const c = client();
    const warnings: string[] = [];
    await deliverRow({
      row: {
        message_id: "m1",
        body: "hello",
        matrix_origin: { sender: "@alice:hs", room_id: "!room:hs", event_id: "$evt" },
      },
      runner: {
        async run() {
          return { reply: "ack" };
        },
      },
      client: c,
      identity: "codex",
      autoReply: true,
      logger: { ...logger, warn: (message) => warnings.push(message) },
    });

    expect(c.sends).toEqual([]);
    expect(warnings).toEqual(["no-routable-reply-target message_id=m1"]);
  });

  test("auto-replies to native row reply_to", async () => {
    const c = client();
    await deliverRow({
      row: { message_id: "m2", body: "hello", sender: "ajs-claude" },
      runner: {
        async run() {
          return { reply: "ack" };
        },
      },
      client: c,
      identity: "codex",
      autoReply: true,
      logger,
    });

    expect(c.sends).toEqual([{ target: "ajs-claude", body: "ack" }]);
  });

  test("configured fallback target is used only when the row has no routable reply target", async () => {
    const matrixClient = client();
    await deliverRow({
      row: {
        message_id: "m3",
        body: "hello",
        matrix_origin: { sender: "@alice:hs", room_id: "!room:hs", event_id: "$evt" },
      },
      runner: {
        async run() {
          return { reply: "ack" };
        },
      },
      client: matrixClient,
      identity: "codex",
      autoReply: true,
      replyTarget: "coordinator-agent",
      logger,
    });
    expect(matrixClient.sends).toEqual([{ target: "coordinator-agent", body: "ack" }]);

    const nativeClient = client();
    await deliverRow({
      row: { message_id: "m4", body: "hello", sender: "ajs-claude" },
      runner: {
        async run() {
          return { reply: "ack" };
        },
      },
      client: nativeClient,
      identity: "codex",
      autoReply: true,
      replyTarget: "coordinator-agent",
      logger,
    });
    expect(nativeClient.sends).toEqual([{ target: "ajs-claude", body: "ack" }]);
  });

  test("does not auto-reply when Codex returns only whitespace", async () => {
    const c = client();
    await deliverRow({
      row: { message_id: "m5", body: "hello", sender: "ajs-claude" },
      runner: {
        async run() {
          return { reply: "   " };
        },
      },
      client: c,
      identity: "codex",
      autoReply: true,
      logger,
    });

    expect(c.sends).toEqual([]);
  });

  test("sendMessage failure bubbles so the poller retries instead of marking seen", async () => {
    const failingClient = {
      ...client(),
      async sendMessage() {
        throw new Error("gateway down");
      },
    };

    await expect(
      deliverRow({
        row: { message_id: "m6", body: "hello", sender: "ajs-claude" },
        runner: {
          async run() {
            return { reply: "ack" };
          },
        },
        client: failingClient,
        identity: "codex",
        autoReply: true,
        logger,
      }),
    ).rejects.toThrow(/gateway down/);
  });
});

describe("runCodexGatewayInboxReceiver", () => {
  test("delivers one row, persists the cursor, and closes the client", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-receiver-"));
    try {
      const cursorPath = join(dir, "cursor.json");
      const controller = new AbortController();
      let closed = false;
      const row = { message_id: "m1", body: "hello", sender: "ajs-claude" };
      const prompts: string[] = [];
      const c: GatewayInboxClient = {
        async getMessages(): Promise<GetMessagesResult> {
          return { ok: true, identity: "codex", messages: [row] };
        },
        async sendMessage() {
          return { ok: true };
        },
        async close() {
          closed = true;
        },
      };

      await runCodexGatewayInboxReceiver({
        identity: "codex",
        gatewayUrl: "https://gw.test",
        workspace: dir,
        keyCommand: "unused",
        client: c,
        cursorPath,
        runner: {
          async run(prompt) {
            prompts.push(prompt);
            controller.abort();
            return {};
          },
        },
        signal: controller.signal,
        logger,
      });

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("message_id: m1");
      expect(new FileCursorStore(cursorPath).load()).toEqual({ seen: ["m1"] });
      expect(closed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runner failure leaves the row unseen so a restart retries it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-receiver-"));
    try {
      const cursorPath = join(dir, "cursor.json");
      const row = { message_id: "retry-me", body: "hello", sender: "ajs-claude" };
      const makeClient = (): GatewayInboxClient => ({
        async getMessages(): Promise<GetMessagesResult> {
          return { ok: true, identity: "codex", messages: [row] };
        },
        async sendMessage() {
          return { ok: true };
        },
        async close() {},
      });

      const first = new AbortController();
      await runCodexGatewayInboxReceiver({
        identity: "codex",
        gatewayUrl: "https://gw.test",
        workspace: dir,
        keyCommand: "unused",
        client: makeClient(),
        cursorPath,
        runner: {
          async run() {
            first.abort();
            throw new Error("codex turn failed");
          },
        },
        signal: first.signal,
        logger,
      });
      expect(new FileCursorStore(cursorPath).load()).toEqual({ seen: [] });

      const second = new AbortController();
      let runs = 0;
      await runCodexGatewayInboxReceiver({
        identity: "codex",
        gatewayUrl: "https://gw.test",
        workspace: dir,
        keyCommand: "unused",
        client: makeClient(),
        cursorPath,
        runner: {
          async run() {
            runs += 1;
            second.abort();
            return {};
          },
        },
        signal: second.signal,
        logger,
      });

      expect(runs).toBe(1);
      expect(new FileCursorStore(cursorPath).load()).toEqual({ seen: ["retry-me"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
