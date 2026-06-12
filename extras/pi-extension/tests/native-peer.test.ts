import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { A2AClientProvider } from "@agents-js/a2a-client";
import {
  createEventHub,
  installNativePeerBridge,
  type NativePiPeerHandle,
  teeEventBus,
} from "../src/native-peer.ts";
import type { PiCustomMessage, PiHost, PiToolRegistration } from "../src/types.ts";

type PiHandler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

const silentLogger = {
  error() {},
  log() {},
  warn() {},
};

type MockPiResponderResult =
  | string
  | Error
  | { kind: "hang" }
  | { kind: "user_agent_error"; message: string }
  | { kind: "chunks"; parts: string[] };

type MockPiResponder = (message: string) => MockPiResponderResult;

class MockPiHost implements PiHost {
  readonly messages: PiCustomMessage[] = [];
  readonly tools: PiToolRegistration[] = [];
  readonly userMessages: string[] = [];
  private readonly handlers = new Map<string, PiHandler[]>();

  constructor(private readonly responder: MockPiResponder = () => "mock response") {}

  on(event: string, handler: PiHandler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerTool(tool: PiToolRegistration): void {
    this.tools.push(tool);
  }

  async sendMessage(message: PiCustomMessage): Promise<void> {
    this.messages.push(message);
  }

  async sendUserMessage(content: string): Promise<void> {
    this.userMessages.push(content);
    await this.emit("input", { text: content, source: "extension" });
    const response = this.responder(content);
    if (response instanceof Error) {
      queueMicrotask(() => {
        void this.emit("extension_error", { error: response.message });
      });
      return;
    }
    if (typeof response === "object" && response !== null && "kind" in response) {
      if (response.kind === "hang") {
        // Intentionally emit nothing further so the runner times out / aborts.
        return;
      }
      if (response.kind === "user_agent_error") {
        queueMicrotask(() => {
          void this.emit("agent_start", {}).then(() =>
            this.emit("agent_error", { message: response.message }),
          );
        });
        return;
      }
      if (response.kind === "chunks") {
        const parts = response.parts;
        const full = parts.join("");
        queueMicrotask(() => {
          let chain = this.emit("agent_start", {});
          for (const part of parts) {
            chain = chain.then(() =>
              this.emit("message_update", {
                assistantMessageEvent: { type: "text_delta", delta: part },
              }),
            );
          }
          void chain.then(() =>
            this.emit("agent_end", {
              messages: [{ role: "assistant", content: [{ type: "text", text: full }] }],
            }),
          );
        });
        return;
      }
    }
    const text = response as string;
    queueMicrotask(() => {
      void this.emit("agent_start", {})
        .then(() =>
          this.emit("message_update", {
            assistantMessageEvent: { type: "text_delta", delta: text },
          }),
        )
        .then(() =>
          this.emit("agent_end", {
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text }],
              },
            ],
          }),
        );
    });
  }

  async emit(event: string, payload: unknown = {}): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.handlers.get(event) ?? []) {
      results.push(await handler(payload, {}));
    }
    return results;
  }
}

let tmpDir: string;
let registryPath: string;
let handles: NativePiPeerHandle[];

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "pi-native-peer-"));
  registryPath = join(tmpDir, "registry.json");
  handles = [];
});

afterEach(async () => {
  await Promise.all(handles.map((handle) => handle.stop()));
  await rm(tmpDir, { recursive: true, force: true });
});

function nativeEnv(name: string): Record<string, string> {
  return {
    AGENTS_JS_PI_NATIVE: "1",
    AGENTS_JS_PI_NAME: name,
    AGENTS_JS_PI_PORT: "0",
    AGENTS_JS_REGISTRY: registryPath,
    HOME: tmpDir,
  };
}

async function startPeer(
  name: string,
  responder: MockPiResponder = (message) => `${name} received: ${message}`,
): Promise<{ handle: NativePiPeerHandle; pi: MockPiHost; url: string }> {
  const pi = new MockPiHost(responder);
  const handle = installNativePeerBridge(pi, { env: nativeEnv(name), logger: silentLogger });
  handles.push(handle);
  await pi.emit("session_start", { reason: "startup" });
  const url = handle.getUrl();
  if (!url) {
    throw new Error(`peer ${name} did not start`);
  }
  return { handle, pi, url };
}

function lastMessage(pi: MockPiHost): string {
  const message = pi.messages.at(-1);
  return message?.content ?? "";
}

async function sendMessage(url: string, text: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "SendMessage",
      params: {
        tenant: "",
        configuration: { returnImmediately: false },
        message: {
          messageId: "m1",
          role: "ROLE_USER",
          parts: [{ text }],
        },
      },
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe("native Pi peer mode", () => {
  test("writes the expected A2A registry entry", async () => {
    const { url } = await startPeer("pi-a");

    const onDisk = JSON.parse(await readFile(registryPath, "utf8"));
    expect(onDisk.version).toBe(2);
    expect(onDisk.agents["pi-a"].kind).toBe("a2a");
    expect(onDisk.agents["pi-a"].url).toBe(url);
    expect(onDisk.agents["pi-a"].source).toBe("auto-reg");
  });

  test("exposes an agent card and accepts message/send", async () => {
    const { pi, url } = await startPeer("pi-a", (message) => `answer for ${message}`);

    const cardResponse = await fetch(`${url}/.well-known/agent-card.json`);
    expect(cardResponse.status).toBe(200);
    const card = (await cardResponse.json()) as {
      name?: string;
      supportedInterfaces?: Array<{ url?: string }>;
    };
    expect(card.name).toBe("pi-a");
    expect(card.supportedInterfaces?.[0]?.url).toBe(url);

    const body = await sendMessage(url, "hello from a2a");
    expect(pi.userMessages).toEqual(["hello from a2a"]);
    expect(JSON.stringify(body)).toContain("answer for hello from a2a");
  });

  test("advertises streaming and streams incremental deltas to a subscribing client", async () => {
    const { url } = await startPeer("pi-a", () => ({
      kind: "chunks",
      parts: ["Hello", " streaming", " world!"],
    }));

    const provider = new A2AClientProvider();
    const deltas: string[] = [];
    let completed = "";
    const unsubscribe = provider.subscribe((event) => {
      if (event.type === "message.delta") {
        deltas.push(event.text);
      } else if (event.type === "message.completed") {
        completed = event.text;
      }
    });

    try {
      const target = await provider.connect({ url });
      // The card now advertises streaming (was hardcoded false).
      expect(target.capabilities.supportsStreaming).toBe(true);
      await provider.sendTurn(target, "hi", { stream: true });
    } finally {
      unsubscribe();
    }

    // Progressive, cumulative deltas (not one final dump), then a completion.
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.at(-1)).toBe("Hello streaming world!");
    expect(completed).toBe("Hello streaming world!");
  });

  test("inbound A2A prompt calls sendUserMessage and resolves from agent_end", async () => {
    const { pi, url } = await startPeer("pi-a", (message) => `finished: ${message}`);

    const body = await sendMessage(url, "run this");

    expect(pi.userMessages).toEqual(["run this"]);
    expect(JSON.stringify(body)).toContain("finished: run this");
  });

  test("inbound A2A prompt fails fast when Pi emits an extension error", async () => {
    const { url } = await startPeer("pi-a", () => new Error("No API key found for test"));

    const body = await sendMessage(url, "run this");

    expect(JSON.stringify(body)).toContain("TASK_STATE_FAILED");
    expect(JSON.stringify(body)).toContain("No API key found for test");
  });

  test("@@ dispatch returns handled and displays the peer answer", async () => {
    await startPeer("pi-b", (message) => `pi-b direct: ${message}`);
    const { pi } = await startPeer("pi-a");

    const results = await pi.emit("input", {
      text: "@@pi-b answer directly",
      source: "interactive",
    });

    expect(results.at(-1)).toEqual({ action: "handled" });
    expect(lastMessage(pi)).toContain("A2A direct reply from pi-b");
    expect(lastMessage(pi)).toContain("pi-b direct: answer directly");
  });

  test("@ mention injects delegation context and continues local agent processing", async () => {
    const peer = await startPeer("pi-b", (message) => `pi-b context: ${message}`);
    const { pi } = await startPeer("pi-a");

    const inputResults = await pi.emit("input", {
      text: "@pi-b review this plan in one sentence",
      source: "interactive",
    });
    const beforeResults = await pi.emit("before_agent_start", {
      prompt: "@pi-b review this plan in one sentence",
    });

    expect(inputResults.at(-1)).toEqual({ action: "continue" });
    expect(peer.pi.userMessages).toEqual(["review this plan in one sentence"]);
    const injection = beforeResults.at(-1) as { message?: PiCustomMessage };
    expect(injection.message?.content).toContain("A2A peer context for this turn");
    expect(injection.message?.content).toContain("pi-b context: review this plan in one sentence");
  });

  test("recovers from a user-typed turn that emits agent_start then agent_error", async () => {
    const { pi, url } = await startPeer("pi-a");
    // Drive a user-typed turn directly: agent_start with NO inbound A2A pending,
    // then agent_error. Before the fix, this leaves agentActive=true forever.
    await pi.emit("agent_start", {});
    await pi.emit("agent_error", { message: "user turn boom" });

    // Inbound A2A must succeed (not be rejected as busy).
    const body = await sendMessage(url, "hello after error");
    expect(JSON.stringify(body)).not.toContain("busy");
    expect(pi.userMessages).toContain("hello after error");
  });

  test("second inbound A2A while one is in flight returns busy", async () => {
    const { url } = await startPeer("pi-a", () => ({ kind: "hang" }) as const);

    const firstAbort = new AbortController();
    const firstPromise = fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: firstAbort.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: {
          tenant: "",
          configuration: { returnImmediately: false },
          message: {
            messageId: "m-first",
            role: "ROLE_USER",
            parts: [{ text: "first" }],
          },
        },
      }),
    }).catch(() => undefined);

    // Wait for the first request to enter "working" state.
    await new Promise((r) => setTimeout(r, 75));

    const secondBody = await sendMessage(url, "second");
    expect(JSON.stringify(secondBody)).toContain("busy");

    // Detach the first request so afterEach can shut down cleanly.
    firstAbort.abort();
    void firstPromise;
  });

  test("turn timeout fails the inbound task and frees the peer", async () => {
    const pi = new MockPiHost(() => ({ kind: "hang" }) as const);
    const handle = installNativePeerBridge(pi, {
      env: { ...nativeEnv("pi-a"), AGENTS_JS_PI_TURN_TIMEOUT_MS: "100" },
      logger: silentLogger,
    });
    handles.push(handle);
    await pi.emit("session_start", { reason: "startup" });
    const url = handle.getUrl();
    if (!url) throw new Error("peer did not start");

    const body1 = await sendMessage(url, "hung one");
    expect(JSON.stringify(body1)).toContain("Timed out");

    // Confirm peer is free for a new turn (responder still hangs, so
    // the second turn will also time out at 100ms — the assertion is
    // just that the response is not a busy rejection).
    const body2 = await sendMessage(url, "follow up");
    expect(JSON.stringify(body2)).not.toContain("busy");
    expect(JSON.stringify(body2)).toContain("Timed out");
  });

  test("cancelTask aborts an in-flight turn and publishes canceled status", async () => {
    // Hang only the first turn so the follow-up assertion (peer accepts a
    // new turn) doesn't have to wait for the default 5-minute timeout.
    let firstTurn = true;
    const { url } = await startPeer("pi-a", (msg) => {
      if (firstTurn) {
        firstTurn = false;
        return { kind: "hang" } as const;
      }
      return `done: ${msg}`;
    });

    // Non-blocking message/send returns as soon as the first event (the
    // submitted task) is published, exposing the auto-generated taskId
    // while the executor is still in flight.
    const sendRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: {
          tenant: "",
          configuration: { returnImmediately: true },
          message: {
            messageId: "m1",
            role: "ROLE_USER",
            parts: [{ text: "hang please" }],
          },
        },
      }),
    });
    expect(sendRes.status).toBe(200);
    const sendBody = (await sendRes.json()) as {
      result?: { task?: { id?: string } };
    };
    const taskId = sendBody.result?.task?.id;
    expect(taskId).toBeTruthy();

    const cancelRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "CancelTask",
        params: { id: taskId },
      }),
    });
    expect(cancelRes.status).toBe(200);
    const cancelBody = (await cancelRes.json()) as {
      result?: { status?: { state?: string } };
    };
    expect(cancelBody.result?.status?.state).toBe("TASK_STATE_CANCELED");

    // Confirm the peer accepts a new turn (proves inflight cleared and
    // agentActive was reset).
    const followRes = await sendMessage(url, "after cancel");
    expect(JSON.stringify(followRes)).not.toContain("busy");
  });

  test("GET /events tees a task's published events to a subscriber", async () => {
    const { url } = await startPeer("pi-a", (message) => `events: ${message}`);

    const controller = new AbortController();
    const eventsRes = await fetch(`${url}/events`, { signal: controller.signal });
    expect(eventsRes.status).toBe(200);
    expect(eventsRes.headers.get("content-type")).toContain("text/event-stream");

    const reader = (eventsRes.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const frames: string[] = [];

    // Read frames until we see a terminal status update or time out.
    const readUntilComplete = (async () => {
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trimEnd();
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
          if (line.startsWith("data:")) {
            frames.push(line.slice(5).trim());
          }
        }
        // The firehose carries the raw SDK AgentEvent; the terminal status
        // is the numeric COMPLETED enum (3), not the wire string vocabulary.
        if (frames.some((f) => f.includes('"kind":"statusUpdate"') && f.includes('"state":3')))
          return;
      }
    })();

    // Drive a turn through the JSON-RPC path; its eventBus publishes must
    // also reach the /events subscriber.
    await sendMessage(url, "hello firehose");
    await Promise.race([readUntilComplete, new Promise((resolve) => setTimeout(resolve, 2000))]);
    controller.abort();
    await readUntilComplete.catch(() => {});

    // The submitted task event and the working/completed status updates
    // should all be visible on the firehose. Each `data:` line is exactly
    // `JSON.stringify(<raw AgentEvent>)`.
    const frame = (predicate: (f: string) => boolean): unknown =>
      JSON.parse(frames.find(predicate) ?? "null");
    const taskFrame = frame((f) => f.includes('"kind":"task"')) as {
      kind?: string;
      data?: { status?: { state?: number } };
    } | null;
    expect(taskFrame?.kind).toBe("task");
    expect(taskFrame?.data?.status?.state).toBe(1); // SUBMITTED
    const joined = frames.join("\n");
    expect(joined).toContain('"state":3'); // COMPLETED
    expect(joined).toContain("events: hello firehose");
  });

  test("GET /events removes the subscriber on disconnect", async () => {
    const { handle, url } = await startPeer("pi-a");

    const controller = new AbortController();
    const eventsRes = await fetch(`${url}/events`, { signal: controller.signal });
    expect(eventsRes.status).toBe(200);
    // Begin draining so the connection is established server-side.
    const reader = (eventsRes.body as ReadableStream<Uint8Array>).getReader();
    void reader.read();

    // Give the server a moment to register the subscriber.
    await new Promise((r) => setTimeout(r, 50));

    controller.abort();
    await reader.cancel().catch(() => {});

    // After disconnect, a subsequent turn must still succeed (no dangling
    // subscriber writing to a closed socket) and stop() must close cleanly.
    await new Promise((r) => setTimeout(r, 50));
    const body = await sendMessage(url, "after disconnect");
    expect(JSON.stringify(body)).not.toContain("busy");
    await handle.stop();
  });

  test("source no longer hardcodes the version literal", async () => {
    const src = await readFile(new URL("../src/native-peer.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/version:\s*"\d+\.\d+\.\d+/);
  });

  test("oversized request body returns 413 with JSON-RPC -32600", async () => {
    const { url } = await startPeer("pi-a");
    const huge = "x".repeat(5 * 1024 * 1024); // 5 MiB > 4 MiB cap
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: {
          tenant: "",
          configuration: { returnImmediately: false },
          message: {
            messageId: "m1",
            role: "ROLE_USER",
            parts: [{ text: huge }],
          },
        },
      }),
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as {
      error: { code: number; message: string; data?: { maxBytes?: number } };
    };
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toBe("Request body too large");
    expect(body.error.data?.maxBytes).toBe(4 * 1024 * 1024);
  });
});

/**
 * Isolation invariant for the /events firehose (PR #211 review BLOCK, raised by
 * cognee-codex, fix per cognee-claude). The diagnostic event mirror must never
 * interfere with the authoritative A2A task lifecycle: a throwing /events
 * observer (or any hub failure) cannot stop `ExecutionEventBus.publish` and thus
 * cannot halt task completion. Tested at the tee level (not just the hub) per
 * the review's "load-bearing regression" request.
 */
describe("teeEventBus / event hub — observer isolation", () => {
  // WHAT: an event published through the teed bus still reaches the REAL bus
  // even when an /events subscriber throws.
  // WHY: the firehose is observe-only; a broken SSE observer must not stop the
  // authoritative publish (which advances/finishes the task).
  test("a throwing /events subscriber does not stop the real bus publish", () => {
    const published: unknown[] = [];
    const realBus = {
      publish: (event: unknown) => {
        published.push(event);
      },
      finished() {},
    };
    const hub = createEventHub();
    hub.subscribe(() => {
      throw new Error("observer boom");
    });
    // The fake satisfies the only members the tee touches (publish + delegated).
    const teed = teeEventBus(realBus as unknown as Parameters<typeof teeEventBus>[0], hub);

    const event = { kind: "task", marker: 1 } as never;
    // The teed publish must not throw, AND the authoritative bus must have run.
    expect(() => teed.publish(event)).not.toThrow();
    expect(published).toEqual([event]);
  });

  // WHAT: one throwing subscriber does not deprive the others of the event.
  // WHY: per-subscriber isolation in broadcast() — defense in depth alongside
  // the tee's catch.
  test("createEventHub.broadcast isolates a throwing subscriber from the rest", () => {
    const hub = createEventHub();
    const delivered: unknown[] = [];
    hub.subscribe(() => {
      throw new Error("boom");
    });
    hub.subscribe((event) => {
      delivered.push(event);
    });

    const event = { kind: "statusUpdate" };
    expect(() => hub.broadcast(event)).not.toThrow();
    expect(delivered).toEqual([event]);
  });
});

/**
 * Self-rebind / re-advertise on host LAN-IP change. A native pi binds its socket
 * to a specific IP and advertises it once; when the host's Wi-Fi/DHCP IP rotates
 * the socket dies and the advertised record goes stale. These tests lock in the
 * fix: bind all-interfaces (0.0.0.0) for a LAN-advertised peer so the socket
 * survives, and re-publish the (re-detected) URL on a heartbeat so the registry
 * record + served agent-card track the current address.
 */
describe("native peer — bind/advertise decouple + IP-change self-rebind", () => {
  // A controllable scheduler: the heartbeat schedules one tick at a time via
  // setTimeout, so capturing the pending callback lets a test drive ticks
  // deterministically (no wall-clock) and assert teardown cancels them.
  function makeScheduler() {
    let pending: (() => void) | null = null;
    let cleared = 0;
    return {
      scheduler: {
        setTimeout: (cb: () => void, _ms: number) => {
          pending = cb;
          return { unref() {} };
        },
        clearTimeout: (_handle: unknown) => {
          cleared += 1;
          pending = null;
        },
      },
      hasPending: () => pending !== null,
      clearedCount: () => cleared,
      async fireNext() {
        const cb = pending;
        pending = null;
        if (cb) cb();
        // Let the async tick (re-detect + registry file write) settle.
        await new Promise((resolve) => setTimeout(resolve, 25));
      },
    };
  }

  // Interfaces source whose IP can be flipped between ticks (DHCP roam).
  function mutableInterfaces(initial: string): {
    source: () => Record<string, readonly { address: string; family: string; internal: boolean }[]>;
    set: (ip: string) => void;
    calls: () => number;
  } {
    let ip = initial;
    let calls = 0;
    return {
      source: () => {
        calls += 1;
        return { en0: [{ address: ip, family: "IPv4", internal: false }] };
      },
      set: (next: string) => {
        ip = next;
      },
      calls: () => calls,
    };
  }

  async function readRegistryUrl(name: string): Promise<string> {
    const data = JSON.parse(await readFile(registryPath, "utf8")) as {
      agents?: Record<string, { url?: string }>;
    };
    return data.agents?.[name]?.url ?? "";
  }

  // Poll the registry until its record url reflects the expected host fragment
  // (the async file write may lag the tick by a few ms).
  async function waitRegistryUrlContains(name: string, frag: string, timeoutMs = 1000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const url = await readRegistryUrl(name).catch(() => "");
      if (url.includes(frag)) return url;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`registry url for ${name} never contained "${frag}"`);
  }

  // Fetch the SERVED agent-card via loopback (always reachable when bind=0.0.0.0)
  // and return its advertised interface url — which carries the (fake) LAN host.
  async function fetchCardIfaceUrl(advertisedUrl: string): Promise<string> {
    const port = new URL(advertisedUrl).port;
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
    const card = (await res.json()) as { supportedInterfaces?: { url?: string }[] };
    return card.supportedInterfaces?.[0]?.url ?? "";
  }

  async function startSeamed(
    name: string,
    extraEnv: Record<string, string>,
    opts: Pick<
      Parameters<typeof installNativePeerBridge>[1] & object,
      "interfacesSource" | "scheduler"
    >,
  ): Promise<NativePiPeerHandle> {
    const pi = new MockPiHost(() => "ok");
    const handle = installNativePeerBridge(pi, {
      env: { ...nativeEnv(name), ...extraEnv },
      logger: silentLogger,
      ...opts,
    });
    handles.push(handle);
    await pi.emit("session_start", { reason: "startup" });
    if (!handle.getUrl()) {
      throw new Error(`peer ${name} did not start`);
    }
    return handle;
  }

  // (a) Decouple: with an EXPLICIT opt-in to all-interface bind
  // (AGENTS_JS_PI_BIND_HOST=0.0.0.0), the peer advertises the LAN host while the
  // socket binds 0.0.0.0 — proven by the card still being fetchable over loopback.
  test("(a) explicit AGENTS_JS_PI_BIND_HOST=0.0.0.0 binds all-interfaces while advertising the LAN host", async () => {
    const ifaces = mutableInterfaces("192.168.50.10");
    const handle = await startSeamed(
      "pi-decouple",
      { AGENTS_JS_PI_HOST: "192.168.50.10", AGENTS_JS_PI_BIND_HOST: "0.0.0.0" },
      { interfacesSource: ifaces.source },
    );
    const url = handle.getUrl() as string;
    expect(url).toContain("192.168.50.10"); // advertised host
    // bind=0.0.0.0 → fetchable over loopback at the advertised port:
    const iface = await fetchCardIfaceUrl(url);
    expect(iface).toContain("192.168.50.10");
    expect(await readRegistryUrl("pi-decouple")).toContain("192.168.50.10");
  });

  // (a2) SECURITY regression (PR #216 review): a non-loopback advertise host does
  // NOT silently fall back to 0.0.0.0. Without an explicit AGENTS_JS_PI_BIND_HOST
  // the server binds the advertise host itself — so binding a host that lacks that
  // exact interface FAILS (proving it did not widen exposure to all interfaces;
  // had it defaulted to 0.0.0.0 the server would have started fine).
  test("(a2) does NOT default to 0.0.0.0 — binds the advertise host (no silent all-interface exposure)", async () => {
    const pi = new MockPiHost(() => "ok");
    // 192.0.2.1 = TEST-NET-1 (RFC 5737); never a real interface on the test host.
    const handle = installNativePeerBridge(pi, {
      env: { ...nativeEnv("pi-noexpose"), AGENTS_JS_PI_HOST: "192.0.2.1" },
      logger: silentLogger,
    });
    handles.push(handle);
    await pi.emit("session_start", { reason: "startup" });
    expect(handle.getUrl()).toBeNull(); // bind to the (absent) advertise iface failed → no 0.0.0.0 fallback
  });

  // (b) THE load-bearing test: when the host IP changes, the next heartbeat tick
  // re-detects it and the registry record AND the served card update in lockstep.
  test("(b) re-advertises the new IP on the next heartbeat tick (registry + card in lockstep)", async () => {
    const ifaces = mutableInterfaces("10.0.0.5");
    const sched = makeScheduler();
    const handle = await startSeamed(
      "pi-roam",
      {
        AGENTS_JS_PI_HOST: "10.0.0.5",
        AGENTS_JS_PI_BIND_HOST: "0.0.0.0",
        AGENTS_JS_PI_HEARTBEAT_INTERVAL_MS: "30000",
      },
      { interfacesSource: ifaces.source, scheduler: sched.scheduler },
    );
    const url = handle.getUrl() as string;
    // Boot: IP-A everywhere.
    expect(await readRegistryUrl("pi-roam")).toContain("10.0.0.5");
    expect(await fetchCardIfaceUrl(url)).toContain("10.0.0.5");

    // The host's Wi-Fi IP rotates; drive one heartbeat tick.
    ifaces.set("10.0.9.99");
    expect(sched.hasPending()).toBe(true);
    await sched.fireNext();

    // Both the registry record and the freshly-served card now carry IP-B.
    expect(await waitRegistryUrlContains("pi-roam", "10.0.9.99")).toContain("10.0.9.99");
    expect(await fetchCardIfaceUrl(url)).toContain("10.0.9.99");
  });

  // (c) Loopback/default advertise stays static and never sniffs interfaces — no
  // accidental LAN exposure, no wasted work.
  test("(c) loopback advertise stays static; interfaces are never sniffed", async () => {
    const ifaces = mutableInterfaces("192.168.50.10");
    const sched = makeScheduler();
    const handle = await startSeamed(
      "pi-loop",
      { AGENTS_JS_PI_HEARTBEAT_INTERVAL_MS: "30000" }, // no AGENTS_JS_PI_HOST → 127.0.0.1
      { interfacesSource: ifaces.source, scheduler: sched.scheduler },
    );
    const url = handle.getUrl() as string;
    expect(url).toContain("127.0.0.1");
    ifaces.set("192.168.50.99");
    await sched.fireNext();
    expect(handle.getUrl()).toContain("127.0.0.1"); // unchanged
    expect(await readRegistryUrl("pi-loop")).toContain("127.0.0.1");
    expect(ifaces.calls()).toBe(0); // never sniffed interfaces
  });

  // (d) Teardown cancels the heartbeat — no leaked timer, no post-stop ticks.
  test("(d) stop() cancels the re-advertise heartbeat (no further ticks)", async () => {
    const ifaces = mutableInterfaces("10.0.0.5");
    const sched = makeScheduler();
    const handle = await startSeamed(
      "pi-teardown",
      {
        AGENTS_JS_PI_HOST: "10.0.0.5",
        AGENTS_JS_PI_BIND_HOST: "0.0.0.0",
        AGENTS_JS_PI_HEARTBEAT_INTERVAL_MS: "30000",
      },
      { interfacesSource: ifaces.source, scheduler: sched.scheduler },
    );
    // The boot tick schedules the next tick asynchronously (after its registry
    // write); let it settle so there is a pending tick for stop() to cancel.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sched.hasPending()).toBe(true);
    await handle.stop();
    expect(sched.clearedCount()).toBeGreaterThanOrEqual(1);
    expect(sched.hasPending()).toBe(false);
    // A would-be tick after stop must not re-register.
    const before = await readRegistryUrl("pi-teardown");
    await sched.fireNext();
    expect(await readRegistryUrl("pi-teardown")).toBe(before);
  });
});

describe("native peer — inbound poller mutual exclusion (#218 gate)", () => {
  // A pollerFactory test double: records each call and returns a handle whose
  // `enabled` reflects whether that path would actually deliver. The gate must
  // ensure the direct-Matrix fallback only starts when the gateway inbox poller
  // is NOT enabled, so a single room mention can never double-inject.
  function recordingFactory(enabled: boolean) {
    let calls = 0;
    const factory = () => {
      calls += 1;
      return { enabled, async stop() {}, async send() {} };
    };
    return { factory, calls: () => calls };
  }

  async function startWithPollers(
    name: string,
    inboxEnabled: boolean,
  ): Promise<{ inboxCalls: () => number; matrixCalls: () => number }> {
    const inbox = recordingFactory(inboxEnabled);
    const matrix = recordingFactory(true);
    const pi = new MockPiHost(() => "ok");
    const handle = installNativePeerBridge(pi, {
      env: nativeEnv(name),
      logger: silentLogger,
      startInboxPoller: inbox.factory as Parameters<
        typeof installNativePeerBridge
      >[1]["startInboxPoller"],
      startMatrixRoomPoller: matrix.factory as Parameters<
        typeof installNativePeerBridge
      >[1]["startMatrixRoomPoller"],
    });
    handles.push(handle);
    await pi.emit("session_start", { reason: "startup" });
    if (!handle.getUrl()) {
      throw new Error(`peer ${name} did not start`);
    }
    return { inboxCalls: inbox.calls, matrixCalls: matrix.calls };
  }

  test("gateway inbox poller LIVE → direct-Matrix poller is NOT started (no double-inject)", async () => {
    const { inboxCalls, matrixCalls } = await startWithPollers("pi-gw-live", true);
    expect(inboxCalls()).toBe(1);
    expect(matrixCalls()).toBe(0);
  });

  test("gateway inbox poller absent → direct-Matrix poller starts as the fallback", async () => {
    const { inboxCalls, matrixCalls } = await startWithPollers("pi-gw-off", false);
    expect(inboxCalls()).toBe(1);
    expect(matrixCalls()).toBe(1);
  });
});

describe("native peer — outbound room-mention echo gating", () => {
  // Spy matrix poller: captures the onMentionInjected hook the peer wires in,
  // and records every send() the peer's room-reply sink makes. The peer only
  // wires the sink when the handle is enabled, mirroring production.
  function spyMatrixFactory() {
    const posted: string[] = [];
    let onMentionInjected: (() => void) | undefined;
    const factory = (_pi: unknown, options: { onMentionInjected?: () => void }) => {
      onMentionInjected = options.onMentionInjected;
      return {
        enabled: true,
        async stop() {},
        async send(body: string) {
          posted.push(body);
        },
      };
    };
    return {
      factory,
      posted,
      // Simulate a room mention: fire the correlation hook, then inject the
      // message into the live session exactly as the real poller does.
      async injectMention(pi: MockPiHost, body: string) {
        onMentionInjected?.();
        await pi.sendUserMessage(body);
      },
    };
  }

  async function startPeerWithSpyMatrix(
    name: string,
    responder: MockPiResponder,
  ): Promise<{ pi: MockPiHost; url: string; spy: ReturnType<typeof spyMatrixFactory> }> {
    const spy = spyMatrixFactory();
    const pi = new MockPiHost(responder);
    const handle = installNativePeerBridge(pi, {
      env: nativeEnv(name),
      logger: silentLogger,
      // gateway inbox OFF so the direct-Matrix fallback (our spy) starts.
      startInboxPoller: (() => ({
        enabled: false,
        async stop() {},
      })) as Parameters<typeof installNativePeerBridge>[1]["startInboxPoller"],
      startMatrixRoomPoller: spy.factory as Parameters<
        typeof installNativePeerBridge
      >[1]["startMatrixRoomPoller"],
    });
    handles.push(handle);
    await pi.emit("session_start", { reason: "startup" });
    const url = handle.getUrl();
    if (!url) throw new Error(`peer ${name} did not start`);
    return { pi, url, spy };
  }

  // The mock host queues the agent_start→message_update→agent_end chain via
  // queueMicrotask; a short real-timer settle lets it run to completion.
  const settle = () => new Promise((r) => setTimeout(r, 25));

  test("room-mention-injected turn echoes the assistant reply back to the room", async () => {
    const { pi, spy } = await startPeerWithSpyMatrix("pi-echo", () => "pong from pi");
    await spy.injectMention(pi, "ping @pi");
    await settle();
    expect(spy.posted).toEqual(["pong from pi"]);
  });

  test("A2A turn (with pending) does NOT echo to the room", async () => {
    const { url, spy } = await startPeerWithSpyMatrix("pi-a2a", (m) => `a2a: ${m}`);
    const body = await sendMessage(url, "do work");
    // The A2A caller still gets its reply...
    expect(JSON.stringify(body)).toContain("a2a: do work");
    // ...but nothing is posted to the room (no room-reply correlation).
    expect(spy.posted).toEqual([]);
  });

  test("a turn with NO room-reply-pending flag does NOT echo to the room", async () => {
    const { pi, spy } = await startPeerWithSpyMatrix("pi-noflag", () => "stray output");
    // Inject WITHOUT firing onMentionInjected — e.g. a user-typed turn. The
    // flag is never set, so agent_end drops the output instead of room-posting.
    await pi.sendUserMessage("just typing locally");
    await settle();
    expect(spy.posted).toEqual([]);
  });

  test("the flag is single-shot: a second non-mention turn does NOT re-echo", async () => {
    const { pi, spy } = await startPeerWithSpyMatrix("pi-once", () => "reply");
    await spy.injectMention(pi, "mention 1");
    await settle();
    // A follow-up local turn with no fresh mention must NOT echo again.
    await pi.sendUserMessage("local follow-up");
    await settle();
    expect(spy.posted).toEqual(["reply"]);
  });
});
