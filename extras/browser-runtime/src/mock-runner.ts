import type { PromptRunner } from "./browser-acp-shim.ts";

/**
 * Splitting the answer into several short pieces lets the playground
 * visibly stream tokens the way the real model does, without depending on
 * WebGPU or model weights.
 */
const MOCK_CHUNKS = [
  "This is the mocked playground. ",
  "I'm not running a real model — ",
  "the events you see follow the same JSON-RPC envelope ",
  "as the live runner, just from a canned script.",
];

const DEFAULT_CHUNK_INTERVAL_MS = 60;

export interface CreateMockRunnerOptions {
  /** Delay between streamed chunks. Tests pass `0` to keep the suite fast. */
  chunkIntervalMs?: number;
}

/**
 * Returns a `PromptRunner` that emits a deterministic tool-invocation +
 * answer-chunk sequence without loading a model. Powers the
 * "Load mocked endpoints" mode of the docs playground so visitors can
 * preview the chat UX without downloading ~700 MB of weights.
 *
 * The event shape mirrors what `BrowserACPShim` would produce when a real
 * model decides to call `searchDocs` and then streams an answer — same
 * JSON-RPC notification envelope, same `params.kind` discriminator.
 */
export function createMockRunner(options: CreateMockRunnerOptions = {}): PromptRunner {
  const intervalMs = options.chunkIntervalMs ?? DEFAULT_CHUNK_INTERVAL_MS;
  return {
    async runPrompt(params, emit) {
      emit({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: params.sessionId, kind: "tool.invoked", tool: "searchDocs" },
      });

      for (const text of MOCK_CHUNKS) {
        if (intervalMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        emit({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: params.sessionId, kind: "answer.chunk", text },
        });
      }
    },
    cancel() {},
    dispose() {},
  };
}
