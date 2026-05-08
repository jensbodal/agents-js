import { CreateWebWorkerMLCEngine, type MLCEngineInterface } from "@mlc-ai/web-llm";
import type { SupportedModelId } from "./model-picker.ts";

export interface LocalModel {
  engine: MLCEngineInterface;
  worker: Worker;
  /**
   * Release the GPU memory held by `engine` and terminate the underlying
   * `WebWorker`. Idempotent: a second call is a no-op so callers don't have
   * to track ownership.
   */
  dispose(): Promise<void>;
}

export interface CreateLocalModelOptions {
  onProgress?: (progress: unknown) => void;
}

export type EngineCreator = (
  worker: Worker,
  modelId: SupportedModelId,
  opts?: { initProgressCallback?: (p: unknown) => void },
) => Promise<MLCEngineInterface>;

export type WorkerFactory = () => Worker;

export async function createLocalModelWith(
  createEngine: EngineCreator,
  workerFactory: WorkerFactory,
  modelId: SupportedModelId,
  opts: CreateLocalModelOptions = {},
): Promise<LocalModel> {
  const worker = workerFactory();
  let engine: MLCEngineInterface;
  try {
    engine = await createEngine(worker, modelId, { initProgressCallback: opts.onProgress });
  } catch (err) {
    worker.terminate();
    throw err;
  }
  let disposed = false;
  return {
    engine,
    worker,
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        // `unload` is documented on `MLCEngineInterface` but optional on
        // some adapters; tearing down anyway, so swallow.
        await (engine as { unload?: () => Promise<void> }).unload?.();
      } catch {
        // intentional: tearing down anyway
      }
      worker.terminate();
    },
  };
}

export async function createLocalModel(
  modelId: SupportedModelId,
  opts: CreateLocalModelOptions = {},
): Promise<LocalModel> {
  const workerFactory: WorkerFactory = () =>
    new Worker(new URL("./webllm-worker.ts", import.meta.url), { type: "module" });
  return createLocalModelWith(
    CreateWebWorkerMLCEngine as unknown as EngineCreator,
    workerFactory,
    modelId,
    opts,
  );
}
