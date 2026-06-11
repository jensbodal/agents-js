import { describe, expect, test } from "bun:test";
import {
  type GatewayInboxClient,
  type GetMessagesResult,
  type InboxMessage,
  MemoryCursorStore,
  type SendMessageResult,
} from "@agents-js/gateway-inbox-runtime";
import { readPiInboxConfig, startPiInboxPoller } from "../src/inbox-poller.ts";
import type { PiContentBlock, PiHost, PiToolRegistration } from "../src/types.ts";

const silentLogger = {
  error() {},
  log() {},
  warn() {},
};

/**
 * Minimal Pi host that records every `sendUserMessage` injection so a test can
 * assert what reached the live session. Mirrors `native-peer.test.ts`'s
 * MockPiHost but trimmed to the inbox-poller's surface (we only inject).
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
 * Scripted inbox client: returns the queued batches in order (one per poll),
 * then an empty batch forever. Records every getMessages call and whether
 * close() was invoked so teardown can be asserted. Never hits a real gateway.
 */
class MockInboxClient implements GatewayInboxClient {
  getMessagesCalls = 0;
  closed = false;
  constructor(
    private readonly identity: string,
    private readonly batches: InboxMessage[][],
  ) {}

  async getMessages(): Promise<GetMessagesResult> {
    const messages = this.batches[this.getMessagesCalls] ?? [];
    this.getMessagesCalls += 1;
    return { ok: true, identity: this.identity, messages };
  }

  async sendMessage(): Promise<SendMessageResult> {
    return { ok: true };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function row(
  overrides: Partial<InboxMessage> & { message_id: string; body: string },
): InboxMessage {
  return overrides;
}

const GATEWAY_ENV: Record<string, string> = {
  CH_GATEWAY_URL: "https://gateway.example.test",
  CH_GATEWAY_IDENTITY: "pi-test-0",
  CH_GATEWAY_KEY_CMD: "echo key",
};

/**
 * Drive the poll loop deterministically. The runtime poller awaits
 * `sleepImpl` between polls; we resolve it but capture each call so the test
 * can wait until the loop has run the desired number of polls before asserting.
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
      // Yield to the microtask queue so onMessage handlers settle.
      await Promise.resolve();
    },
    waitForPolls(n: number): Promise<void> {
      if (polls >= n) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ n, resolve }));
    },
  };
}

describe("readPiInboxConfig", () => {
  // Purpose: native-only agents (no gateway env) must yield null so the poller
  // is a no-op and never attempts a JWT mint.
  test("returns null when required gateway env is absent", () => {
    expect(readPiInboxConfig({})).toBeNull();
    expect(readPiInboxConfig({ CH_GATEWAY_URL: "x" })).toBeNull();
    expect(readPiInboxConfig({ CH_GATEWAY_URL: "x", CH_GATEWAY_IDENTITY: "y" })).toBeNull();
  });

  // Purpose: identity falls back to AGENTS_JS_PI_NAME so a native A2A peer
  // reuses its own name for the inbox subject.
  test("resolves identity from AGENTS_JS_PI_NAME fallback", () => {
    const config = readPiInboxConfig({
      CH_GATEWAY_URL: "https://gw",
      CH_GATEWAY_KEY_CMD: "echo k",
      AGENTS_JS_PI_NAME: "pi-fallback-0",
    });
    expect(config?.identity).toBe("pi-fallback-0");
  });

  // Purpose: the explicit kill switch disables the feature even when fully
  // configured.
  test("returns null when AGENTS_JS_PI_INBOX_ENABLED=0", () => {
    expect(readPiInboxConfig({ ...GATEWAY_ENV, AGENTS_JS_PI_INBOX_ENABLED: "0" })).toBeNull();
  });
});

describe("startPiInboxPoller", () => {
  // Purpose (a): with gateway env present, an inbound inbox row is injected into
  // the live session via pi.sendUserMessage with the expected untrusted-body
  // formatting (sender + body framed as data).
  test("injects an inbound row via sendUserMessage with expected formatting", async () => {
    const pi = new MockPiHost();
    const client = new MockInboxClient("pi-test-0", [
      [row({ message_id: "m1", body: "hello from peer", sender: "peer-agent" })],
    ]);
    const paced = pacedSleep();

    const handle = startPiInboxPoller(pi, {
      env: GATEWAY_ENV,
      logger: silentLogger,
      client,
      cursorStore: new MemoryCursorStore(),
      sleepImpl: paced.sleepImpl,
    });
    expect(handle.enabled).toBe(true);

    await paced.waitForPolls(1);
    await handle.stop();

    expect(pi.userMessages).toHaveLength(1);
    const injected = pi.userMessages[0] ?? "";
    expect(injected).toContain("Incoming agents-js gateway inbox message.");
    expect(injected).toContain("untrusted peer content");
    expect(injected).toContain("message_id: m1");
    expect(injected).toContain("sender_identity: peer-agent");
    expect(injected).toContain("Body:\nhello from peer");
  });

  // Purpose (b): cursor advances — a row already delivered is not injected a
  // second time across subsequent polls (dedup by message_id via the runtime
  // cursor store).
  test("does not deliver the same row twice", async () => {
    const pi = new MockPiHost();
    const duplicate = row({ message_id: "dup-1", body: "only once" });
    // The same row is returned on every poll; the cursor must suppress repeats.
    const client = new MockInboxClient("pi-test-0", [[duplicate], [duplicate], [duplicate]]);
    const paced = pacedSleep();

    const handle = startPiInboxPoller(pi, {
      env: GATEWAY_ENV,
      logger: silentLogger,
      client,
      cursorStore: new MemoryCursorStore(),
      sleepImpl: paced.sleepImpl,
    });

    await paced.waitForPolls(3);
    await handle.stop();

    expect(pi.userMessages).toHaveLength(1);
  });

  // Purpose (c): with NO gateway env the poller is a no-op — it returns a
  // disabled handle and never touches the runtime client (no mint, no poll).
  test("is a no-op when gateway env is absent", async () => {
    const pi = new MockPiHost();
    const client = new MockInboxClient("pi-test-0", [[row({ message_id: "x", body: "y" })]]);

    const handle = startPiInboxPoller(pi, {
      env: {},
      logger: silentLogger,
      client,
      cursorStore: new MemoryCursorStore(),
    });

    expect(handle.enabled).toBe(false);
    await handle.stop();
    expect(client.getMessagesCalls).toBe(0);
    expect(pi.userMessages).toHaveLength(0);
  });

  // Purpose (d): teardown stops the poller — after stop() resolves, no further
  // poll runs and the inbox client is closed (resources released).
  test("stop() halts polling and closes the client", async () => {
    const pi = new MockPiHost();
    const client = new MockInboxClient("pi-test-0", [[], [], []]);
    const paced = pacedSleep();

    const handle = startPiInboxPoller(pi, {
      env: GATEWAY_ENV,
      logger: silentLogger,
      client,
      cursorStore: new MemoryCursorStore(),
      sleepImpl: paced.sleepImpl,
    });

    await paced.waitForPolls(1);
    await handle.stop();
    expect(client.closed).toBe(true);

    const callsAfterStop = client.getMessagesCalls;
    // Give any stray loop iteration a chance to run; it must not.
    await Promise.resolve();
    await Promise.resolve();
    expect(client.getMessagesCalls).toBe(callsAfterStop);

    // stop() is idempotent.
    await handle.stop();
  });
});
