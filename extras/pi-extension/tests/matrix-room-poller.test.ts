import { describe, expect, test } from "bun:test";
import { MemoryCursorStore } from "@agents-js/gateway-inbox-runtime";
import {
  type MatrixRoomClient,
  type MatrixTimelineEvent,
  readMatrixRoomConfig,
  startPiMatrixRoomPoller,
} from "../src/matrix-room-poller.ts";
import type { PiContentBlock, PiHost, PiToolRegistration } from "../src/types.ts";

const silentLogger = {
  error() {},
  log() {},
  warn() {},
};

/**
 * Minimal Pi host that records every `sendUserMessage` injection so a test can
 * assert what reached the live session.
 */
class MockPiHost implements PiHost {
  readonly userMessages: string[] = [];

  on(): void {}
  registerTool(_tool: PiToolRegistration): void {}

  async sendUserMessage(content: string | PiContentBlock[]): Promise<void> {
    this.userMessages.push(typeof content === "string" ? content : JSON.stringify(content));
  }
}

/**
 * Scripted Matrix room client: returns the queued {nextBatch, events} batches in
 * order (one per sync call), then an empty batch (reusing the last nextBatch)
 * forever. Records every sync call. Never hits the network.
 */
class MockMatrixClient implements MatrixRoomClient {
  syncCalls = 0;
  whoamiCalls = 0;
  syncSinceArgs: Array<string | undefined> = [];
  constructor(
    private readonly self: string,
    private readonly batches: Array<{ nextBatch: string; events: MatrixTimelineEvent[] }>,
  ) {}

  async sync(
    since: string | undefined,
  ): Promise<{ nextBatch: string; events: MatrixTimelineEvent[] }> {
    this.syncSinceArgs.push(since);
    const batch = this.batches[this.syncCalls];
    this.syncCalls += 1;
    if (batch) return batch;
    const last = this.batches[this.batches.length - 1];
    return { nextBatch: last?.nextBatch ?? "EMPTY", events: [] };
  }

  async whoami(): Promise<string> {
    this.whoamiCalls += 1;
    return this.self;
  }
}

function msg(
  overrides: Partial<MatrixTimelineEvent> & {
    event_id: string;
    sender: string;
  } & { content?: MatrixTimelineEvent["content"] },
): MatrixTimelineEvent {
  return {
    type: "m.room.message",
    content: { msgtype: "m.text", body: "hi", ...overrides.content },
    ...overrides,
  };
}

const DIRECT_ENV: Record<string, string> = {
  AGENTS_JS_PI_MATRIX_DIRECT: "1",
  CH_MATRIX_HOMESERVER: "https://matrix.example.test",
  CH_MATRIX_ROOM_ID: "!room:matrix.example.test",
  CH_MATRIX_TOKEN_CMD: "echo token",
  CH_GATEWAY_IDENTITY: "pi-test-0",
  CH_MATRIX_SELF_MXID: "@pi-test-0:matrix.example.test",
};

/**
 * Drive the poll loop deterministically. The loop awaits `sleepImpl` between
 * polls; we resolve it but capture each call so a test can wait until the loop
 * has run the desired number of polls before asserting.
 */
function pacedSleep(): {
  sleepImpl: (ms: number, signal: AbortSignal) => Promise<void>;
  waitForPolls(n: number): Promise<void>;
} {
  let polls = 0;
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  return {
    sleepImpl: async () => {
      polls += 1;
      for (const w of waiters) {
        if (polls >= w.n) w.resolve();
      }
      // Yield so onMessage handlers settle.
      await Promise.resolve();
    },
    waitForPolls(n: number): Promise<void> {
      if (polls >= n) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ n, resolve }));
    },
  };
}

describe("readMatrixRoomConfig", () => {
  // Purpose: OFF by default — without the explicit opt-in, no direct-matrix mode.
  test("returns null without AGENTS_JS_PI_MATRIX_DIRECT", () => {
    const { AGENTS_JS_PI_MATRIX_DIRECT, ...withoutOptIn } = DIRECT_ENV;
    expect(readMatrixRoomConfig(withoutOptIn)).toBeNull();
  });

  // Purpose: every transport field is required even once opted in.
  test("returns null when any required transport env is missing", () => {
    expect(readMatrixRoomConfig({ AGENTS_JS_PI_MATRIX_DIRECT: "1" })).toBeNull();
    expect(
      readMatrixRoomConfig({
        AGENTS_JS_PI_MATRIX_DIRECT: "1",
        CH_MATRIX_HOMESERVER: "https://h",
      }),
    ).toBeNull();
    expect(
      readMatrixRoomConfig({
        AGENTS_JS_PI_MATRIX_DIRECT: "1",
        CH_MATRIX_HOMESERVER: "https://h",
        CH_MATRIX_ROOM_ID: "!r:h",
      }),
    ).toBeNull();
    // homeserver + room + token but no identity → still null.
    expect(
      readMatrixRoomConfig({
        AGENTS_JS_PI_MATRIX_DIRECT: "1",
        CH_MATRIX_HOMESERVER: "https://h",
        CH_MATRIX_ROOM_ID: "!r:h",
        CH_MATRIX_TOKEN_CMD: "echo t",
      }),
    ).toBeNull();
  });

  // Purpose: a fully-specified opt-in env yields a config with parsed defaults.
  test("returns a config when all required env is present", () => {
    const config = readMatrixRoomConfig(DIRECT_ENV);
    expect(config).not.toBeNull();
    expect(config?.homeserver).toBe("https://matrix.example.test");
    expect(config?.roomId).toBe("!room:matrix.example.test");
    expect(config?.tokenCommand).toBe("echo token");
    expect(config?.identity).toBe("pi-test-0");
    expect(config?.intervalMs).toBe(15000);
    expect(config?.mentionsOnly).toBe(false);
    expect(config?.selfMxid).toBe("@pi-test-0:matrix.example.test");
  });

  // Purpose: identity falls back to AGENTS_JS_PI_NAME for the cursor scope.
  test("resolves identity from AGENTS_JS_PI_NAME fallback", () => {
    const { CH_GATEWAY_IDENTITY, ...rest } = DIRECT_ENV;
    const config = readMatrixRoomConfig({ ...rest, AGENTS_JS_PI_NAME: "pi-fallback-0" });
    expect(config?.identity).toBe("pi-fallback-0");
  });
});

describe("startPiMatrixRoomPoller", () => {
  // Purpose: with no opt-in the poller is a disabled no-op handle and never
  // touches the client (no whoami, no sync).
  test("returns a disabled no-op handle when config is null", async () => {
    const pi = new MockPiHost();
    const client = new MockMatrixClient("@pi-test-0:matrix.example.test", [
      { nextBatch: "b1", events: [msg({ event_id: "$e1", sender: "@peer:h" })] },
    ]);

    const handle = startPiMatrixRoomPoller(pi, {
      env: {},
      logger: silentLogger,
      client,
      cursorStore: new MemoryCursorStore(),
    });

    expect(handle.enabled).toBe(false);
    await handle.stop();
    expect(client.syncCalls).toBe(0);
    expect(pi.userMessages).toHaveLength(0);
  });

  // Purpose: first run stores the cursor (next_batch) and injects NOTHING — the
  // backlog from the initial sync is suppressed to avoid dumping history.
  test("first run stores the cursor and suppresses backlog", async () => {
    const pi = new MockPiHost();
    const cursor = new MemoryCursorStore();
    const client = new MockMatrixClient("@pi-test-0:matrix.example.test", [
      {
        nextBatch: "b1",
        events: [
          msg({ event_id: "$old1", sender: "@peer:h", content: { body: "ancient" } }),
          msg({ event_id: "$old2", sender: "@peer:h", content: { body: "history" } }),
        ],
      },
    ]);
    const paced = pacedSleep();

    const handle = startPiMatrixRoomPoller(pi, {
      env: DIRECT_ENV,
      logger: silentLogger,
      client,
      cursorStore: cursor,
      sleepImpl: paced.sleepImpl,
    });
    expect(handle.enabled).toBe(true);

    await paced.waitForPolls(1);
    await handle.stop();

    expect(pi.userMessages).toHaveLength(0);
    expect(cursor.load().seen).toEqual(["b1"]);
  });

  // Purpose: on the poll AFTER priming, a new message from another sender is
  // injected with the untrusted-content guard framing and the body present.
  test("injects a new message from another sender after priming", async () => {
    const pi = new MockPiHost();
    const client = new MockMatrixClient("@pi-test-0:matrix.example.test", [
      { nextBatch: "b1", events: [] }, // priming sync
      {
        nextBatch: "b2",
        events: [
          msg({
            event_id: "$new1",
            sender: "@peer:matrix.example.test",
            content: { msgtype: "m.text", body: "hello from peer" },
          }),
        ],
      },
    ]);
    const paced = pacedSleep();

    const handle = startPiMatrixRoomPoller(pi, {
      env: DIRECT_ENV,
      logger: silentLogger,
      client,
      cursorStore: new MemoryCursorStore(),
      sleepImpl: paced.sleepImpl,
    });

    await paced.waitForPolls(2);
    await handle.stop();

    expect(pi.userMessages).toHaveLength(1);
    const injected = pi.userMessages[0] ?? "";
    expect(injected).toContain("Incoming Matrix room message (direct bridge).");
    expect(injected).toContain("untrusted peer content");
    expect(injected).toContain("event_id: $new1");
    expect(injected).toContain("room_id: !room:matrix.example.test");
    expect(injected).toContain("sender: @peer:matrix.example.test");
    expect(injected).toContain("Body:\nhello from peer");
  });

  // Purpose: an event whose sender is self (own echo) is skipped.
  test("skips events sent by self", async () => {
    const pi = new MockPiHost();
    const client = new MockMatrixClient("@pi-test-0:matrix.example.test", [
      { nextBatch: "b1", events: [] }, // priming
      {
        nextBatch: "b2",
        events: [
          msg({
            event_id: "$mine",
            sender: "@pi-test-0:matrix.example.test",
            content: { body: "my own message" },
          }),
          msg({
            event_id: "$theirs",
            sender: "@peer:matrix.example.test",
            content: { body: "their message" },
          }),
        ],
      },
    ]);
    const paced = pacedSleep();

    const handle = startPiMatrixRoomPoller(pi, {
      env: DIRECT_ENV,
      logger: silentLogger,
      client,
      cursorStore: new MemoryCursorStore(),
      sleepImpl: paced.sleepImpl,
    });

    await paced.waitForPolls(2);
    await handle.stop();

    expect(pi.userMessages).toHaveLength(1);
    expect(pi.userMessages[0]).toContain("event_id: $theirs");
  });

  // Purpose: mentionsOnly=true gates injection on a self-mention in
  // m.mentions.user_ids; a non-mentioning message is skipped.
  test("mentionsOnly injects only messages that mention self", async () => {
    const pi = new MockPiHost();
    const self = "@pi-test-0:matrix.example.test";
    const client = new MockMatrixClient(self, [
      { nextBatch: "b1", events: [] }, // priming
      {
        nextBatch: "b2",
        events: [
          msg({
            event_id: "$nomention",
            sender: "@peer:matrix.example.test",
            content: { body: "just chatting" },
          }),
          msg({
            event_id: "$mention",
            sender: "@peer:matrix.example.test",
            content: {
              body: "hey pi",
              ["m.mentions"]: { user_ids: [self] },
            },
          }),
        ],
      },
    ]);
    const paced = pacedSleep();

    const handle = startPiMatrixRoomPoller(pi, {
      env: { ...DIRECT_ENV, CH_MATRIX_MENTIONS_ONLY: "1" },
      logger: silentLogger,
      client,
      cursorStore: new MemoryCursorStore(),
      sleepImpl: paced.sleepImpl,
    });

    await paced.waitForPolls(2);
    await handle.stop();

    expect(pi.userMessages).toHaveLength(1);
    expect(pi.userMessages[0]).toContain("event_id: $mention");
  });

  // Purpose: the cursor advances to the latest next_batch across polls, and the
  // since-token passed to sync follows it — no re-injection of seen events.
  test("cursor advances across polls without re-injecting seen events", async () => {
    const pi = new MockPiHost();
    const cursor = new MemoryCursorStore();
    const client = new MockMatrixClient("@pi-test-0:matrix.example.test", [
      { nextBatch: "b1", events: [] }, // priming
      {
        nextBatch: "b2",
        events: [
          msg({
            event_id: "$one",
            sender: "@peer:matrix.example.test",
            content: { body: "first" },
          }),
        ],
      },
      {
        nextBatch: "b3",
        events: [
          msg({
            event_id: "$two",
            sender: "@peer:matrix.example.test",
            content: { body: "second" },
          }),
        ],
      },
    ]);
    const paced = pacedSleep();

    const handle = startPiMatrixRoomPoller(pi, {
      env: DIRECT_ENV,
      logger: silentLogger,
      client,
      cursorStore: cursor,
      sleepImpl: paced.sleepImpl,
    });

    await paced.waitForPolls(3);
    await handle.stop();

    // Two distinct events, each injected exactly once.
    expect(pi.userMessages).toHaveLength(2);
    expect(pi.userMessages[0]).toContain("event_id: $one");
    expect(pi.userMessages[1]).toContain("event_id: $two");
    expect(cursor.load().seen).toEqual(["b3"]);
    // The since arg advances: first sync undefined, then b1, then b2.
    expect(client.syncSinceArgs.slice(0, 3)).toEqual([undefined, "b1", "b2"]);
  });

  // Purpose: stop() halts the loop — after stop, advancing the fake clock
  // triggers no further sync or injection.
  test("stop() halts the loop", async () => {
    const pi = new MockPiHost();
    const client = new MockMatrixClient("@pi-test-0:matrix.example.test", [
      { nextBatch: "b1", events: [] },
      { nextBatch: "b2", events: [] },
    ]);
    const paced = pacedSleep();

    const handle = startPiMatrixRoomPoller(pi, {
      env: DIRECT_ENV,
      logger: silentLogger,
      client,
      cursorStore: new MemoryCursorStore(),
      sleepImpl: paced.sleepImpl,
    });

    await paced.waitForPolls(1);
    await handle.stop();

    const callsAfterStop = client.syncCalls;
    // Give any stray loop iteration a chance to run; it must not.
    await Promise.resolve();
    await Promise.resolve();
    expect(client.syncCalls).toBe(callsAfterStop);
    expect(pi.userMessages).toHaveLength(0);

    // stop() is idempotent.
    await handle.stop();
  });
});
