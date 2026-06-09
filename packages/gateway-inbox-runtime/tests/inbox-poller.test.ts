import { describe, expect, test } from "bun:test";
import { MemoryCursorStore } from "../src/cursor-store.ts";
import type {
  GatewayInboxClient,
  GetMessagesResult,
  InboxMessage,
  SendMessageResult,
} from "../src/gateway-inbox-client.ts";
import { dedupKey, runInboxPoller } from "../src/inbox-poller.ts";

const IDENTITY = "hostname-null-claude-0";

function row(partial: Partial<InboxMessage> & { message_id: string }): InboxMessage {
  return { body: `body ${partial.message_id}`, ...partial };
}

function ok(messages: InboxMessage[], identity = IDENTITY): GetMessagesResult {
  return { ok: true, identity, messages };
}

/** Fake client: scripted getMessages by call index; records sends. */
class FakeClient implements GatewayInboxClient {
  calls = 0;
  sent: Array<{ target: string; body: string; identity: string }> = [];
  constructor(private readonly script: (n: number) => GetMessagesResult) {}
  async getMessages(): Promise<GetMessagesResult> {
    return this.script(this.calls++);
  }
  async sendMessage(a: {
    target: string;
    body: string;
    identity: string;
  }): Promise<SendMessageResult> {
    this.sent.push(a);
    return { ok: true };
  }
  async close(): Promise<void> {}
}

/** Drive the poller for exactly `polls` polls, then abort. */
async function drive(opts: {
  client: GatewayInboxClient;
  onMessage: (r: InboxMessage) => void | Promise<void>;
  store?: MemoryCursorStore;
  polls: number;
}): Promise<void> {
  const controller = new AbortController();
  let n = 0;
  await runInboxPoller({
    client: opts.client,
    identity: IDENTITY,
    onMessage: opts.onMessage,
    cursorStore: opts.store ?? new MemoryCursorStore(),
    signal: controller.signal,
    logger: { log() {}, warn() {}, error() {} },
    sleepImpl: async () => {
      if (++n >= opts.polls) controller.abort();
    },
  });
}

describe("dedupKey", () => {
  test("prefers idempotency_key, falls back to message_id", () => {
    expect(dedupKey(row({ message_id: "m1", idempotency_key: "evt:tgt" }))).toBe("evt:tgt");
    expect(dedupKey(row({ message_id: "m1", idempotency_key: null }))).toBe("m1");
    expect(dedupKey(row({ message_id: "m1" }))).toBe("m1");
  });
});

describe("runInboxPoller", () => {
  test("same idempotency_key across two polls emits once", async () => {
    const r = row({ message_id: "m1", idempotency_key: "evt1:tgt" });
    const client = new FakeClient(() => ok([r]));
    const got: string[] = [];
    await drive({ client, onMessage: (m) => void got.push(m.message_id), polls: 2 });
    expect(got).toEqual(["m1"]);
  });

  test("native rows (null idempotency_key) dedup on message_id", async () => {
    const r = row({ message_id: "m1", idempotency_key: null, kind: "agents_message" });
    const client = new FakeClient(() => ok([r]));
    const got: string[] = [];
    await drive({ client, onMessage: (m) => void got.push(m.message_id), polls: 3 });
    expect(got).toEqual(["m1"]);
  });

  test("persisted cursor survives restart — no re-surface", async () => {
    const store = new MemoryCursorStore();
    const r = row({ message_id: "m1", idempotency_key: "evt1:tgt" });
    const got: string[] = [];
    const c1 = new FakeClient(() => ok([r]));
    await drive({ client: c1, onMessage: (m) => void got.push(m.message_id), store, polls: 1 });
    expect(got).toEqual(["m1"]);
    // New poller, SAME store, same row still in the inbox window.
    const c2 = new FakeClient(() => ok([r]));
    await drive({ client: c2, onMessage: (m) => void got.push(m.message_id), store, polls: 1 });
    expect(got).toEqual(["m1"]); // unchanged
  });

  test("identity mismatch halts and emits nothing", async () => {
    const client = new FakeClient(() => ok([row({ message_id: "m1" })], "someone-else"));
    const got: string[] = [];
    // No abort needed: the poller returns on the guard violation.
    await runInboxPoller({
      client,
      identity: IDENTITY,
      onMessage: (m) => void got.push(m.message_id),
      cursorStore: new MemoryCursorStore(),
      signal: new AbortController().signal,
      logger: { log() {}, warn() {}, error() {} },
      sleepImpl: async () => {},
    });
    expect(got).toEqual([]);
    expect(client.calls).toBe(1);
  });

  test("delivers oldest-first by created_at", async () => {
    const rows = [
      row({ message_id: "new", created_at: 3000 }),
      row({ message_id: "old", created_at: 1000 }),
      row({ message_id: "mid", created_at: 2000 }),
    ];
    const client = new FakeClient(() => ok(rows));
    const got: string[] = [];
    await drive({ client, onMessage: (m) => void got.push(m.message_id), polls: 1 });
    expect(got).toEqual(["old", "mid", "new"]);
  });

  test("a throwing sink leaves the row unseen and retries next poll", async () => {
    const r = row({ message_id: "m1", idempotency_key: "evt1:tgt" });
    const client = new FakeClient(() => ok([r]));
    let attempts = 0;
    const delivered: string[] = [];
    await drive({
      client,
      onMessage: (m) => {
        attempts++;
        if (attempts === 1) throw new Error("transient sink failure");
        delivered.push(m.message_id);
      },
      polls: 3,
    });
    expect(attempts).toBe(2); // failed once, retried, succeeded — then deduped
    expect(delivered).toEqual(["m1"]);
  });

  test("transport failures back off, leave cursor unchanged, and reset after success", async () => {
    const r = row({ message_id: "m1", idempotency_key: "evt1:tgt" });
    const script = (n: number): GetMessagesResult => {
      if (n === 0) throw new Error("network unreachable");
      if (n === 1) return { ok: false, identity: IDENTITY, messages: [r] };
      return ok([r]);
    };
    const client = new FakeClient(script);
    const controller = new AbortController();
    const sleeps: number[] = [];
    const got: string[] = [];
    const store = new MemoryCursorStore();

    await runInboxPoller({
      client,
      identity: IDENTITY,
      onMessage: (m) => void got.push(m.message_id),
      cursorStore: store,
      signal: controller.signal,
      intervalMs: 10,
      backoffMaxMs: 20,
      logger: { log() {}, warn() {}, error() {} },
      sleepImpl: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length >= 3) controller.abort();
      },
    });

    expect(sleeps).toEqual([10, 20, 10]);
    expect(got).toEqual(["m1"]);
    expect(store.load()).toEqual({ seen: ["evt1:tgt"] });
  });
});
