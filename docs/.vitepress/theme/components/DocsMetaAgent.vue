<template>
  <div ref="containerRef"></div>
</template>

<script setup lang="ts">
import type { DocsCorpus, PromptRunner, SupportedModelId } from "@agents-js/browser-runtime";
import { onBeforeUnmount, onMounted, ref } from "vue";
// Type-only import: keeps the Lit element out of the SSR bundle. The runtime
// side-effect import (which registers the `<docs-playground-shell>` custom
// element) happens inside `onMounted` below, where `window`/`customElements`
// exist.
import type { DocsPlaygroundShell } from "./docs-playground-shell.ts";

// Mount imperatively into a plain div rather than using `<ClientOnly>` +
// `ref` on the custom element directly. VitePress's `<ClientOnly>` does not
// reliably forward refs into its slot, and an SSR'd `<docs-playground-shell>`
// tag inside the Vue template confuses hydration. A plain `<div>` SSRs
// cleanly and we own the create/append/teardown of the Lit element ourselves.
const containerRef = ref<HTMLDivElement | null>(null);
let host: DocsPlaygroundShell | null = null;

onMounted(async () => {
  await import("./docs-playground-shell.ts"); // registers the <docs-playground-shell> custom element
  const {
    createDefaultTools,
    createInMemoryTelemetry,
    createLocalModel,
    createMetaAgentLoop,
    createMockRunner,
    createToolRegistry,
    createWebLLMAdapter,
  } = await import("@agents-js/browser-runtime");

  const container = containerRef.value;
  if (!container) return;

  // `customElements.get` returns the constructor we just registered; cast
  // through `unknown` because TS sees the lookup as `CustomElementConstructor`.
  const Ctor = customElements.get("docs-playground-shell") as unknown as
    | (new () => DocsPlaygroundShell)
    | undefined;
  if (!Ctor) {
    container.textContent = "Failed to register <docs-playground-shell> custom element.";
    return;
  }
  host = new Ctor();
  container.appendChild(host);

  // Mock factory wired before model factory so the toggle works even if a
  // mock-only visitor never triggers the corpus fetch / model download.
  host.mockRunnerFactory = async () => createMockRunner();

  // Memoized corpus fetch — only runs when the user picks model mode.
  // Mock-only visitors never pay the docs-index.json round-trip.
  let corpusPromise: Promise<DocsCorpus> | null = null;
  const getCorpus = (): Promise<DocsCorpus> => {
    if (!corpusPromise) {
      // BASE_URL always ends in `/` (Vite convention).
      corpusPromise = fetch(`${import.meta.env.BASE_URL}docs-index.json`).then(async (resp) => {
        if (!resp.ok) {
          throw new Error(`Failed to load docs index (${resp.status} ${resp.statusText}).`);
        }
        return (await resp.json()) as DocsCorpus;
      });
    }
    return corpusPromise;
  };

  host.runnerFactory = async (
    modelId: SupportedModelId,
    onProgress: (p: unknown) => void,
  ): Promise<PromptRunner> => {
    const corpus = await getCorpus();
    const handlers = createDefaultTools(corpus);
    const tools = createToolRegistry({
      searchDocs: handlers.searchDocs,
      readCodeSnippet: handlers.readCodeSnippet,
    });
    const model = await createLocalModel(modelId, { onProgress });
    const adapter = createWebLLMAdapter(model);
    const telemetry = createInMemoryTelemetry();
    return createMetaAgentLoop({ adapter, tools, telemetry });
  };
});

onBeforeUnmount(() => {
  if (host?.parentElement) host.parentElement.removeChild(host);
  host = null;
});
</script>
