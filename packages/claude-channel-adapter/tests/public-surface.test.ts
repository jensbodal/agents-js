/**
 * Public-surface contract for `@agents-js/claude-channel-adapter`.
 *
 * The reusable inbox-poller primitive (`runInboxPoller` + a transport +
 * a cursor-store + the row types) MUST be importable from the package's
 * public entry (`.`), so external consumers — the lifestone daemon, the
 * Codex sink (#88 gap-1), any harness adapter — can compose a runtime
 * entry: wire the poller to their own `onMessage` sink. Until BL-54, these
 * lived as internal modules only `bin/launcher.ts` reached.
 *
 * This test pins that surface: a row fetched by a fake client flows through
 * to a custom sink, all wired from the public index — not deep imports.
 */
import { describe, expect, test } from "bun:test";
import {
  dedupKey,
  FileCursorStore,
  type GatewayInboxClient,
  type GetMessagesResult,
  HttpGatewayInboxClient,
  type InboxMessage,
  MemoryCursorStore,
  runInboxPoller,
} from "../src/index.ts";

describe("public surface — reusable inbox-poller primitive", () => {
  test("poller + cursor-store + transport + dedupKey are exported from the public entry", () => {
    expect(typeof runInboxPoller).toBe("function");
    expect(typeof dedupKey).toBe("function");
    expect(typeof MemoryCursorStore).toBe("function"); // class constructor
    expect(typeof FileCursorStore).toBe("function");
    expect(typeof HttpGatewayInboxClient).toBe("function");
  });

  test("a runtime entry composes from the public surface — row flows to a custom sink", async () => {
    const IDENTITY = "hostname-null-claude-0";
    const message: InboxMessage = { message_id: "m1", body: "hello" };
    const client: GatewayInboxClient = {
      async getMessages(): Promise<GetMessagesResult> {
        return { ok: true, identity: IDENTITY, messages: [message] };
      },
      async sendMessage() {
        return { ok: true };
      },
      async close() {},
    };

    const received: InboxMessage[] = [];
    const controller = new AbortController();
    let polls = 0;
    await runInboxPoller({
      client,
      identity: IDENTITY,
      onMessage: (r) => {
        received.push(r);
      },
      cursorStore: new MemoryCursorStore(),
      signal: controller.signal,
      logger: { log() {}, warn() {}, error() {} },
      sleepImpl: async () => {
        if (++polls >= 1) controller.abort();
      },
    });

    expect(received.map((r) => r.message_id)).toEqual(["m1"]);
    // dedupKey is the contract consumers mirror; exporting it avoids re-impl.
    expect(dedupKey(message)).toBe("m1");
  });
});
