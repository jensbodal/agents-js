import { describe, expect, it } from "bun:test";
import { BrowserACPShim, type JsonRpcMessage } from "./browser-acp-shim.ts";

describe("BrowserACPShim", () => {
  it("responds to initialize with declared capabilities", async () => {
    const out: JsonRpcMessage[] = [];
    const shim = new BrowserACPShim(
      {
        runPrompt: async () => {},
        cancel: () => {},
      },
      (m) => out.push(m),
    );
    await shim.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(out[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { capabilities: { streaming: true, structuredActions: true } },
    });
  });

  it("session/new returns a UUID sessionId", async () => {
    const out: JsonRpcMessage[] = [];
    const shim = new BrowserACPShim(
      {
        runPrompt: async () => {},
        cancel: () => {},
      },
      (m) => out.push(m),
    );
    await shim.handle({ jsonrpc: "2.0", id: 2, method: "session/new" });
    // biome-ignore lint/suspicious/noExplicitAny: result-shape access in test
    const result = (out[0] as any).result as { sessionId: string };
    expect(result.sessionId).toMatch(/[0-9a-f-]{36}/);
  });

  it("session/prompt delegates to runner and emits a final result", async () => {
    let called = false;
    const out: JsonRpcMessage[] = [];
    const shim = new BrowserACPShim(
      {
        runPrompt: async (_params, emit) => {
          called = true;
          emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: { kind: "answer.chunk", text: "hi" },
          });
        },
        cancel: () => {},
      },
      (m) => out.push(m),
    );
    await shim.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: "abc", input: "hello" },
    });
    expect(called).toBe(true);
    expect(out[0]).toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: { kind: "answer.chunk", text: "hi" },
    });
    // The shim also emits a final result envelope after the runner completes.
    expect(out.length).toBe(2);
  });

  it("returns method-not-found for unknown methods", async () => {
    const out: JsonRpcMessage[] = [];
    const shim = new BrowserACPShim(
      {
        runPrompt: async () => {},
        cancel: () => {},
      },
      (m) => out.push(m),
    );
    await shim.handle({ jsonrpc: "2.0", id: 99, method: "made.up" });
    // biome-ignore lint/suspicious/noExplicitAny: error-shape access in test
    expect((out[0] as any).error.code).toBe(-32601);
  });

  it("session/cancel calls runner.cancel and emits ok result", async () => {
    const cancelled: string[] = [];
    const out: JsonRpcMessage[] = [];
    const shim = new BrowserACPShim(
      {
        runPrompt: async () => {},
        cancel: (sessionId) => {
          cancelled.push(sessionId);
        },
      },
      (m) => out.push(m),
    );
    await shim.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "session/cancel",
      params: { sessionId: "abc" },
    });
    expect(cancelled).toEqual(["abc"]);
    expect(out[0]).toEqual({ jsonrpc: "2.0", id: 4, result: { ok: true } });
  });

  it("session/prompt with invalid params emits -32602 invalid params", async () => {
    const out: JsonRpcMessage[] = [];
    const shim = new BrowserACPShim(
      {
        runPrompt: async () => {
          throw new Error("should not be called");
        },
        cancel: () => {},
      },
      (m) => out.push(m),
    );
    await shim.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "session/prompt",
      params: { sessionId: 123 }, // wrong type, missing input
    });
    // biome-ignore lint/suspicious/noExplicitAny: error-shape access in test
    expect((out[0] as any).error.code).toBe(-32602);
  });

  it("session/cancel during an in-flight session/prompt forwards sessionId to runner.cancel", async () => {
    // The shim's contract is contract-level only: it must call
    // `runner.cancel(sessionId)` on a session/cancel request. The actual
    // mid-stream interruption is the loop's responsibility (covered in
    // meta-agent-loop.test.ts). This test pins the wire-through.
    const cancelled: string[] = [];
    const out: JsonRpcMessage[] = [];
    const promptStarted = Promise.withResolvers<void>();
    const allowFinish = Promise.withResolvers<void>();
    const shim = new BrowserACPShim(
      {
        runPrompt: async (params, emit) => {
          promptStarted.resolve();
          emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: { kind: "answer.chunk", text: "partial" },
          });
          await allowFinish.promise;
          // After cancel we'd expect the runner's loop to emit cancelled,
          // but since this is a fake runner we just verify cancel was
          // observed at the right moment.
          if (cancelled.includes(params.sessionId)) {
            emit({ jsonrpc: "2.0", method: "session/update", params: { kind: "cancelled" } });
          }
        },
        cancel: (sessionId) => {
          cancelled.push(sessionId);
          allowFinish.resolve();
        },
      },
      (m) => out.push(m),
    );

    const promptHandle = shim.handle({
      jsonrpc: "2.0",
      id: 7,
      method: "session/prompt",
      params: { sessionId: "abc", input: "hi" },
    });
    await promptStarted.promise;
    await shim.handle({
      jsonrpc: "2.0",
      id: 8,
      method: "session/cancel",
      params: { sessionId: "abc" },
    });
    await promptHandle;

    expect(cancelled).toEqual(["abc"]);
    // biome-ignore lint/suspicious/noExplicitAny: event-shape access
    expect(out.some((m: any) => m.params?.kind === "cancelled")).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: event-shape access
    expect(out.some((m: any) => m.id === 8 && m.result?.ok === true)).toBe(true);
  });

  it("session/prompt emits -32603 when runner throws", async () => {
    const out: JsonRpcMessage[] = [];
    const shim = new BrowserACPShim(
      {
        runPrompt: async () => {
          throw new Error("runner exploded");
        },
        cancel: () => {},
      },
      (m) => out.push(m),
    );
    await shim.handle({
      jsonrpc: "2.0",
      id: 6,
      method: "session/prompt",
      params: { sessionId: "abc", input: "hi" },
    });
    // The shim should emit a single error envelope, not the success result.
    // biome-ignore lint/suspicious/noExplicitAny: error-shape access in test
    const error = (out[0] as any).error;
    expect(error.code).toBe(-32603);
    expect(error.message).toBe("runner exploded");
    expect(out.length).toBe(1);
  });
});
