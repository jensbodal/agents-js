import { describe, expect, it } from "bun:test";
import { createLocalModelWith, type EngineCreator, type LocalModel } from "./local-model.ts";

describe("createLocalModelWith", () => {
  it("creates a worker, calls the injected engine creator, and exposes chat", async () => {
    const fakeChat = { completions: { create: async () => ({ choices: [] }) } };
    const fakeEngine = { chat: fakeChat, getMessage: async () => "hi" };
    const creator: EngineCreator = async (_worker, _modelId, opts) => {
      opts?.initProgressCallback?.({ progress: 1, text: "loaded" });
      // biome-ignore lint/suspicious/noExplicitAny: test stub for MLCEngineInterface
      return fakeEngine as any;
    };

    const progress: unknown[] = [];
    const model: LocalModel = await createLocalModelWith(
      creator,
      () => ({ postMessage: () => {}, terminate: () => {} }) as unknown as Worker,
      "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
      { onProgress: (p) => progress.push(p) },
    );

    expect(progress.length).toBe(1);
    // biome-ignore lint/suspicious/noExplicitAny: comparing object identity, not Chat surface
    expect(model.engine.chat).toBe(fakeChat as any);
  });

  it("propagates engine creation errors", async () => {
    const creator: EngineCreator = async () => {
      throw new Error("device-lost");
    };
    await expect(
      createLocalModelWith(
        creator,
        () => ({ postMessage: () => {}, terminate: () => {} }) as unknown as Worker,
        "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
      ),
    ).rejects.toThrow("device-lost");
  });
});
