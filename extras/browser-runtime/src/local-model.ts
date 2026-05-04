import { CreateWebWorkerMLCEngine, type MLCEngineInterface } from "@mlc-ai/web-llm";
import type { SupportedModelId } from "./model-picker.ts";

export interface LocalModel {
  engine: MLCEngineInterface;
  worker: Worker;
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
  const engine = await createEngine(worker, modelId, { initProgressCallback: opts.onProgress });
  return { engine, worker };
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
