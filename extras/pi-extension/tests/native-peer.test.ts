import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { A2AClientProvider } from "@agents-js/a2a-client";
import { installNativePeerBridge, type NativePiPeerHandle } from "../src/native-peer.ts";
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
