import { describe, expect, test } from "bun:test";
import { curlFetch, MemoryCursorStore } from "@agents-js/gateway-inbox-runtime";
import {
  HttpMatrixRoomClient,
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

  sentBodies: string[] = [];
  async send(body: string): Promise<void> {
    this.sentBodies.push(body);
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

  // Purpose: native fetch by default — no curl override when the selector env
  // is unset (BL-64 fix is strictly opt-in).
  test("leaves fetchImpl undefined when no fetch selector env is set", () => {
    expect(readMatrixRoomConfig(DIRECT_ENV)?.fetchImpl).toBeUndefined();
  });

  // Purpose: CH_MATRIX_FETCH=curl selects the curl-backed transport (BL-64).
  test("selects curlFetch when CH_MATRIX_FETCH=curl", () => {
    const config = readMatrixRoomConfig({ ...DIRECT_ENV, CH_MATRIX_FETCH: "curl" });
    expect(config?.fetchImpl).toBe(curlFetch);
  });

  // Purpose: CH_GATEWAY_FETCH=curl is honored as the shared fallback selector
  // so a single env flips both the gateway and direct-matrix pollers to curl.
  test("falls back to CH_GATEWAY_FETCH=curl for the curl transport", () => {
    const config = readMatrixRoomConfig({ ...DIRECT_ENV, CH_GATEWAY_FETCH: "curl" });
    expect(config?.fetchImpl).toBe(curlFetch);
  });

  // Purpose: CH_MATRIX_FETCH takes precedence over CH_GATEWAY_FETCH.
  test("CH_MATRIX_FETCH overrides CH_GATEWAY_FETCH", () => {
    const config = readMatrixRoomConfig({
      ...DIRECT_ENV,
      CH_MATRIX_FETCH: "fetch",
      CH_GATEWAY_FETCH: "curl",
    });
    // CH_MATRIX_FETCH=fetch (not "curl") → native, ignoring CH_GATEWAY_FETCH.
    expect(config?.fetchImpl).toBeUndefined();
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

  // Purpose: when NO client seam is injected, the default HTTP client routes
  // through the global `fetch` by default (native transport, BL-64 opt-out).
  test("default HTTP client uses global fetch when no curl override", async () => {
    const pi = new MockPiHost();
    const paced = pacedSleep();
    let globalFetchCalls = 0;
    const realFetch = globalThis.fetch;
    // Stub the global so the real /sync never hits the network.
    globalThis.fetch = (async (url: string | URL | Request) => {
      globalFetchCalls += 1;
      const path = String(url);
      const body = path.includes("/whoami")
        ? { user_id: "@pi-test-0:matrix.example.test" }
        : { next_batch: "b1", rooms: { join: {} } };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    try {
      const handle = startPiMatrixRoomPoller(pi, {
        env: DIRECT_ENV, // no CH_MATRIX_FETCH → native fetch
        logger: silentLogger,
        cursorStore: new MemoryCursorStore(),
        sleepImpl: paced.sleepImpl,
      });
      expect(handle.enabled).toBe(true);
      await paced.waitForPolls(1);
      await handle.stop();
    } finally {
      globalThis.fetch = realFetch;
    }

    // The default client hit the global fetch (whoami + at least one sync).
    expect(globalFetchCalls).toBeGreaterThan(0);
  });

  // Purpose: with CH_MATRIX_FETCH=curl the default client routes through the
  // curl transport, NOT the global `fetch` (the BL-64 TCC-blocked path). We
  // assert the global stub is never touched; curlFetch attempts a real curl,
  // which errors against the fake host and is swallowed by the loop's retry.
  test("CH_MATRIX_FETCH=curl bypasses global fetch for the default client", async () => {
    const pi = new MockPiHost();
    const paced = pacedSleep();
    let globalFetchCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      globalFetchCalls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const handle = startPiMatrixRoomPoller(pi, {
        env: { ...DIRECT_ENV, CH_MATRIX_FETCH: "curl" },
        logger: silentLogger,
        cursorStore: new MemoryCursorStore(),
        sleepImpl: paced.sleepImpl,
      });
      expect(handle.enabled).toBe(true);
      await paced.waitForPolls(1);
      await handle.stop();
    } finally {
      globalThis.fetch = realFetch;
    }

    // curl owns the transport; the global fetch must never be invoked.
    expect(globalFetchCalls).toBe(0);
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

  // Purpose: when a mention is injected, the poller fires onMentionInjected
  // BEFORE the injection so the native peer can correlate the forthcoming reply.
  test("calls onMentionInjected before injecting a matched mention", async () => {
    const pi = new MockPiHost();
    const events: string[] = [];
    // Override sendUserMessage to record ordering relative to the hook.
    pi.sendUserMessage = async (content) => {
      events.push(`inject:${typeof content === "string" ? content.includes("$m1") : false}`);
    };
    const client = new MockMatrixClient("@pi-test-0:matrix.example.test", [
      { nextBatch: "b1", events: [] }, // priming
      {
        nextBatch: "b2",
        events: [
          msg({
            event_id: "$m1",
            sender: "@peer:matrix.example.test",
            content: { body: "hey pi" },
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
      onMentionInjected: () => events.push("hook"),
    });

    await paced.waitForPolls(2);
    await handle.stop();

    // Hook fires immediately before the injection it correlates with.
    expect(events).toEqual(["hook", "inject:true"]);
  });

  // Purpose: the enabled handle exposes send(), delegating to the client.
  test("handle.send() delegates to the client send", async () => {
    const pi = new MockPiHost();
    const client = new MockMatrixClient("@pi-test-0:matrix.example.test", [
      { nextBatch: "b1", events: [] },
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
    await handle.send("echoed reply");
    await handle.stop();
    expect(client.sentBodies).toEqual(["echoed reply"]);
  });
});

describe("HttpMatrixRoomClient.send", () => {
  // Purpose: send() issues a PUT to the room's send endpoint, with bearer auth,
  // an m.text body, and ROUTES THROUGH THE INJECTED fetchImpl — never the global
  // fetch (the BL-64 TCC-blocked path).
  test("PUTs m.room.message with room id + bearer auth via the injected fetchImpl", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let globalFetchCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      globalFetchCalls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const injected = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ event_id: "$sent" }), { status: 200 });
    }) as typeof fetch;

    try {
      const client = new HttpMatrixRoomClient(
        "https://matrix.example.test",
        "!room:matrix.example.test",
        "echo my-secret-token",
        injected,
      );
      await client.send("hello room");
    } finally {
      globalThis.fetch = realFetch;
    }

    // The global fetch is never touched — the injected transport owns the PUT.
    expect(globalFetchCalls).toBe(0);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("no fetch call recorded");
    expect(call.init.method).toBe("PUT");
    // URL: rooms/{roomId}/send/m.room.message/{txnId}.
    expect(call.url).toContain("https://matrix.example.test/_matrix/client/v3/rooms/");
    expect(call.url).toContain(encodeURIComponent("!room:matrix.example.test"));
    expect(call.url).toContain("/send/m.room.message/");
    // Bearer auth from the token command (do not assert the secret value verbatim
    // beyond confirming the command output is wired through).
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer my-secret-token");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(call.init.body))).toEqual({
      msgtype: "m.text",
      body: "hello room",
    });
  });

  // Purpose: each send() uses a fresh, unique txnId (monotonic counter) so two
  // posts are not collapsed by Matrix idempotency.
  test("uses a unique txnId per send", async () => {
    const urls: string[] = [];
    const injected = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const client = new HttpMatrixRoomClient("https://h", "!r:h", "echo t", injected);
    await client.send("one");
    await client.send("two");
    const txn = (u: string) => u.slice(u.lastIndexOf("/") + 1);
    expect(urls).toHaveLength(2);
    expect(txn(urls[0] ?? "")).not.toBe(txn(urls[1] ?? ""));
  });

  // Purpose: a non-2xx response surfaces as an error (so the echo failure is
  // logged, not silently swallowed).
  test("throws on a non-ok response", async () => {
    const injected = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;
    const client = new HttpMatrixRoomClient("https://h", "!r:h", "echo t", injected);
    await expect(client.send("nope")).rejects.toThrow(/403/);
  });
});
