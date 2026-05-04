import type { PromptRunner } from "./browser-acp-shim.ts";
import type { RuntimeId } from "./manifest-schema.ts";
import { createMockRunner } from "./mock-runner.ts";

/**
 * What the playground UI needs to know about a tool the runtime can drive.
 * Intentionally name+description only — full schema introspection happens
 * elsewhere (action-schema.ts) and isn't a runtime concern.
 */
export interface ToolDescriptor {
  name: string;
  description?: string;
}

export interface RuntimeCapabilities {
  streaming: boolean;
  tools: ToolDescriptor[];
}

/**
 * Adapter shape the playground store talks to so the UI never imports a
 * specific runtime impl. Runtime adapters can be added without changing the
 * shell.
 *
 * `createRunner` is async because the local-wasm path may need to spin up
 * a worker / load weights before it can answer. The store treats this as
 * the run-bootstrap latency window.
 */
export interface RuntimeAdapter {
  id: RuntimeId;
  createRunner(opts: { onProgress?: (p: unknown) => void }): Promise<PromptRunner>;
  describeCapabilities(): RuntimeCapabilities;
}

/**
 * Mock adapter — wraps `createMockRunner`. Reports `id: "mock"`, the
 * dedicated runtime slot for canned-response previews. Use this when the
 * docs visitor picks `mock` in the manifest editor's runtime selector or
 * when running the playground in CI / SSR where WebGPU is unavailable.
 *
 * The `agents-js-gateway` runtime id is reserved for a future remote-runtime
 * adapter; it validates against the manifest schema but does NOT have an
 * adapter implementation yet. The manifest editor surfaces this as a disabled
 * "coming soon" option.
 */
export function createMockRuntimeAdapter(): RuntimeAdapter {
  return {
    id: "mock",
    async createRunner() {
      return createMockRunner({ chunkIntervalMs: 60 });
    },
    describeCapabilities() {
      return {
        streaming: true,
        // Mirrors the tool the mock runner pretends to invoke.
        tools: [{ name: "searchDocs", description: "Mocked docs search" }],
      };
    },
  };
}

export interface LocalWasmRuntimeOptions {
  /**
   * Factory that produces the actual runner. Injected (rather than imported
   * at module top) so this module stays browser-mountable lazily — the WebLLM
   * adapter / worker code only loads when the consumer calls `createRunner`,
   * not when the manifest schema is introspected.
   */
  runnerFactory: (opts: { onProgress?: (p: unknown) => void }) => Promise<PromptRunner>;
}

/**
 * Local-wasm adapter — represents the in-browser WebLLM runtime. The runner
 * factory is injected so tests can pass a stub and the docs site can pass
 * a real `createMetaAgentLoop`-driven runner without this module pulling in
 * `@mlc-ai/web-llm` at import time.
 */
export function createLocalWasmRuntimeAdapter(opts: LocalWasmRuntimeOptions): RuntimeAdapter {
  return {
    id: "local-wasm-worker",
    async createRunner(runnerOpts) {
      return opts.runnerFactory(runnerOpts);
    },
    describeCapabilities() {
      return {
        streaming: true,
        // Tool surface is host-provided (the consumer wires `createDefaultTools`
        // into the loop). Adapter doesn't enumerate.
        tools: [],
      };
    },
  };
}
