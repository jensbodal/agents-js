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

  it("propagates engine creation errors and terminates the worker", async () => {
    const creator: EngineCreator = async () => {
      throw new Error("device-lost");
    };
    let terminateCount = 0;
    const fakeWorker = {
      postMessage: () => {},
      terminate: () => {
        terminateCount += 1;
      },
    } as unknown as Worker;
    await expect(
      createLocalModelWith(creator, () => fakeWorker, "Qwen2.5-1.5B-Instruct-q4f16_1-MLC"),
    ).rejects.toThrow("device-lost");
    expect(terminateCount).toBe(1);
  });

  it("dispose() unloads the engine, terminates the worker, and is idempotent", async () => {
    let unloadCount = 0;
    let terminateCount = 0;
    const fakeEngine = {
      chat: { completions: { create: async () => ({ choices: [] }) } },
      unload: async () => {
        unloadCount += 1;
      },
    };
    const creator: EngineCreator = async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test stub for MLCEngineInterface
      return fakeEngine as any;
    };
    const fakeWorker = {
      postMessage: () => {},
      terminate: () => {
        terminateCount += 1;
      },
    } as unknown as Worker;
    const model = await createLocalModelWith(
      creator,
      () => fakeWorker,
      "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    );
    await model.dispose();
    expect(unloadCount).toBe(1);
    expect(terminateCount).toBe(1);
    // Idempotent — second call must not double-unload or double-terminate.
    await model.dispose();
    expect(unloadCount).toBe(1);
    expect(terminateCount).toBe(1);
  });

  it("dispose() swallows unload errors and still terminates the worker", async () => {
    let terminateCount = 0;
    const fakeEngine = {
      chat: { completions: { create: async () => ({ choices: [] }) } },
      unload: async () => {
        throw new Error("engine state already torn down");
      },
    };
    const creator: EngineCreator = async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test stub for MLCEngineInterface
      return fakeEngine as any;
    };
    const fakeWorker = {
      postMessage: () => {},
      terminate: () => {
        terminateCount += 1;
      },
    } as unknown as Worker;
    const model = await createLocalModelWith(
      creator,
      () => fakeWorker,
      "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    );
    await model.dispose();
    expect(terminateCount).toBe(1);
  });
});
