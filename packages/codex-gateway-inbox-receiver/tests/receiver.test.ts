import { describe, expect, test } from "bun:test";
import type { GatewayInboxClient, GetMessagesResult } from "@agents-js/gateway-inbox-runtime";
import { deliverRow } from "../src/receiver.ts";

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
});
