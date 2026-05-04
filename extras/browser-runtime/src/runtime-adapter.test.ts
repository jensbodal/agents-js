import { describe, expect, it } from "bun:test";
import type { JsonRpcMessage, PromptRunner } from "./browser-acp-shim.ts";
import { createLocalWasmRuntimeAdapter, createMockRuntimeAdapter } from "./runtime-adapter.ts";

describe("createMockRuntimeAdapter", () => {
  it("reports the mock runtime id", () => {
    const adapter = createMockRuntimeAdapter();
    expect(adapter.id).toBe("mock");
  });

  it("describeCapabilities returns streaming + advertised tool names", () => {
    const adapter = createMockRuntimeAdapter();
    const caps = adapter.describeCapabilities();
    expect(caps.streaming).toBe(true);
    expect(caps.tools.some((t) => t.name === "searchDocs")).toBe(true);
  });

  it("createRunner returns a usable PromptRunner that emits chunks", async () => {
    const adapter = createMockRuntimeAdapter();
    const runner = await adapter.createRunner({});
    const events: JsonRpcMessage[] = [];
    await runner.runPrompt({ sessionId: "s1", input: "hi" }, (m) => events.push(m));
    expect(events.length).toBeGreaterThan(0);
    const kinds = events
      .map((e) => ("method" in e ? (e as { params?: { kind?: string } }).params?.kind : undefined))
      .filter(Boolean);
    expect(kinds.includes("answer.chunk")).toBe(true);
  });
});

describe("createLocalWasmRuntimeAdapter", () => {
  it("reports the local-wasm runtime id", () => {
    const adapter = createLocalWasmRuntimeAdapter({
      runnerFactory: async () => stubRunner(),
    });
    expect(adapter.id).toBe("local-wasm-worker");
  });

  it("describeCapabilities reports streaming and an empty tool list (provided by host)", () => {
    const adapter = createLocalWasmRuntimeAdapter({
      runnerFactory: async () => stubRunner(),
    });
    const caps = adapter.describeCapabilities();
    expect(caps.streaming).toBe(true);
    // Tool surface is host-provided in M1 — adapter doesn't enumerate.
    expect(Array.isArray(caps.tools)).toBe(true);
  });

  it("createRunner delegates to the injected factory and forwards onProgress", async () => {
    let receivedProgress = false;
    const adapter = createLocalWasmRuntimeAdapter({
      runnerFactory: async (opts) => {
        if (opts.onProgress) receivedProgress = true;
        return stubRunner();
      },
    });
    const runner = await adapter.createRunner({ onProgress: () => {} });
    expect(receivedProgress).toBe(true);
    expect(typeof runner.runPrompt).toBe("function");
    expect(typeof runner.cancel).toBe("function");
  });

  it("createRunner without onProgress still works", async () => {
    const adapter = createLocalWasmRuntimeAdapter({
      runnerFactory: async () => stubRunner(),
    });
    const runner = await adapter.createRunner({});
    expect(runner).toBeDefined();
  });
});

function stubRunner(): PromptRunner {
  return {
    async runPrompt() {
      // no-op
    },
    cancel() {},
  };
}
