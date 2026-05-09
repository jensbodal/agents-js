import { describe, expect, test } from "bun:test";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import type { DroidExecClient, DroidExecClientOptions } from "../src/droid-exec-client.ts";
import { DroidAcpSession } from "../src/session.ts";
import type { DroidStreamEvent } from "../src/types.ts";

/**
 * Build a fake AgentSideConnection that records `sessionUpdate` calls into
 * an array. `DroidAcpSession` only ever invokes `sessionUpdate` on the
 * connection; the rest of the interface is intentionally left as a cast.
 */
function makeFakeConnection(): {
  connection: AgentSideConnection;
  updates: SessionNotification[];
} {
  const updates: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (n: SessionNotification) => {
      updates.push(n);
    },
  } as unknown as AgentSideConnection;
  return { connection, updates };
}

/**
 * Synchronous scripted fake of `DroidExecClient`. Delivers a predetermined
 * event sequence via the `onEvent` callback and then signals exit via
 * `onExit`. Records kill() invocations so tests can assert process-group
 * teardown without spawning real children.
 */
class FakeDroidExecClient {
  readonly kills: NodeJS.Signals[] = [];
  private exited = false;

  constructor(
    private readonly options: DroidExecClientOptions & {
      script: {
        events?: DroidStreamEvent[];
        exit?: { code: number | null; signal: NodeJS.Signals | null };
        deferMs?: number;
        dropCompletion?: boolean;
      };
    },
  ) {
    const {
      events = [],
      exit = { code: 0, signal: null },
      deferMs = 0,
      dropCompletion,
    } = options.script;
    const deliver = (): void => {
      for (const event of events) {
        if (this.exited) return;
        if (dropCompletion && event.type === "completion") continue;
        this.options.onEvent(event);
      }
      // When completion is intentionally dropped, stay alive until kill() so
      // cancel-path tests can exercise SIGTERM teardown. Otherwise, simulate
      // droid exiting on its own once the scripted events are delivered.
      if (!this.exited && !dropCompletion) {
        this.exited = true;
        this.options.onExit(exit);
      }
    };
    if (deferMs > 0) {
      setTimeout(deliver, deferMs);
    } else {
      queueMicrotask(deliver);
    }
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.kills.push(signal);
    if (!this.exited) {
      this.exited = true;
      this.options.onExit({ code: null, signal });
    }
  }

  get pid(): number | undefined {
    return 999;
  }

  get isExited(): boolean {
    return this.exited;
  }
}

describe("DroidAcpSession.prompt", () => {
  test("streams events to the connection and resolves with end_turn on completion", async () => {
    const { connection, updates } = makeFakeConnection();
    let createdClient: FakeDroidExecClient | null = null;
    const session = new DroidAcpSession({
      sessionId: "acp-1",
      connection,
      cwd: "/tmp/work",
      clientFactory: (options) => {
        const client = new FakeDroidExecClient({
          ...options,
          script: {
            events: [
              {
                type: "system",
                subtype: "init",
                cwd: "/tmp/work",
                session_id: "droid-s1",
                tools: [],
                model: "m",
                reasoning_effort: "high",
              },
              {
                type: "message",
                role: "assistant",
                id: "a-1",
                text: "<thinking>plan</thinking>\n\nHi!",
                timestamp: 1,
                session_id: "droid-s1",
              },
              {
                type: "completion",
                finalText: "Hi!",
                numTurns: 1,
                durationMs: 1,
                session_id: "droid-s1",
                timestamp: 2,
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                },
              },
            ],
          },
        });
        createdClient = client;
        return client as unknown as DroidExecClient;
      },
    });

    const result = await session.prompt("hi");
    expect(result.stopReason).toBe("end_turn");
    expect(createdClient).not.toBeNull();
    // One assistant_message_chunk made it through; the thinking block was stripped.
    const messageChunks = updates.filter(
      (u) => (u.update as { sessionUpdate?: string }).sessionUpdate === "agent_message_chunk",
    );
    expect(messageChunks).toHaveLength(1);
    expect((messageChunks[0]?.update as { content: { text: string } }).content.text).toBe("Hi!");
  });

  test("threads droid session_id into the second turn's --session-id flag", async () => {
    const { connection } = makeFakeConnection();
    const capturedArgs: Array<Partial<DroidExecClientOptions>> = [];
    const script = {
      events: [
        {
          type: "system",
          subtype: "init",
          cwd: "/tmp",
          session_id: "droid-captured",
          tools: [],
          model: "m",
          reasoning_effort: "high",
        } as DroidStreamEvent,
        {
          type: "completion",
          finalText: "ok",
          numTurns: 1,
          durationMs: 1,
          session_id: "droid-captured",
          timestamp: 2,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        } as DroidStreamEvent,
      ],
    };
    const session = new DroidAcpSession({
      sessionId: "acp-2",
      connection,
      clientFactory: (options) => {
        capturedArgs.push({
          prompt: options.prompt,
          sessionId: options.sessionId,
        });
        return new FakeDroidExecClient({ ...options, script }) as unknown as DroidExecClient;
      },
    });

    await session.prompt("turn 1");
    await session.prompt("turn 2");

    expect(capturedArgs).toEqual([
      { prompt: "turn 1", sessionId: undefined },
      { prompt: "turn 2", sessionId: "droid-captured" },
    ]);
  });

  test("cancel() kills the active child and resolves the prompt as cancelled", async () => {
    const { connection } = makeFakeConnection();
    let capturedClient: FakeDroidExecClient | null = null;
    const session = new DroidAcpSession({
      sessionId: "acp-3",
      connection,
      clientFactory: (options) => {
        const client = new FakeDroidExecClient({
          ...options,
          script: {
            // Drop the completion so the child "hangs" until cancelled.
            events: [
              {
                type: "system",
                subtype: "init",
                cwd: "/tmp",
                session_id: "s",
                tools: [],
                model: "m",
                reasoning_effort: "high",
              },
            ],
            dropCompletion: true,
            deferMs: 5,
          },
        });
        capturedClient = client;
        return client as unknown as DroidExecClient;
      },
    });

    const promptPromise = session.prompt("hang");
    // Give the fake child a microtask to install.
    await Bun.sleep(20);
    session.cancel();
    const result = await promptPromise;
    expect(result.stopReason).toBe("cancelled");
    expect(capturedClient).not.toBeNull();
    expect((capturedClient as FakeDroidExecClient | null)?.kills).toContain("SIGTERM");
  });

  test("early child exit without completion rejects the prompt", async () => {
    const { connection } = makeFakeConnection();
    const session = new DroidAcpSession({
      sessionId: "acp-4",
      connection,
      clientFactory: (options) =>
        new FakeDroidExecClient({
          ...options,
          script: {
            events: [],
            exit: { code: 1, signal: null },
          },
        }) as unknown as DroidExecClient,
    });

    await expect(session.prompt("boom")).rejects.toThrow(/droid process exited before completion/);
  });

  test("concurrent prompt without awaiting prior rejects", async () => {
    const { connection } = makeFakeConnection();
    const session = new DroidAcpSession({
      sessionId: "acp-5",
      connection,
      clientFactory: (options) =>
        new FakeDroidExecClient({
          ...options,
          script: {
            events: [],
            dropCompletion: true,
            deferMs: 100,
          },
        }) as unknown as DroidExecClient,
    });
    // Kick off one prompt and immediately try a second; the second's promise
    // should reject (not hang) because `pendingPrompt` is already set by the
    // synchronous portion of the first call.
    const first = session.prompt("first");
    await expect(session.prompt("second")).rejects.toThrow(/already has a prompt in flight/);
    // Cancel the first prompt so it doesn't leak past the test boundary.
    session.cancel();
    const firstResult = await first;
    expect(firstResult.stopReason).toBe("cancelled");
  });
});
