<template>
  <div ref="containerRef"></div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
// Type-only import: keeps the Lit element out of the SSR bundle. The runtime
// side-effect import (which registers the `<docs-canvas-viewer>` custom
// element) happens inside `onMounted` below, where `window` /
// `customElements` exist.
import type { ArchitectureCanvasDoc, DocsCanvasViewer } from "./docs-canvas-viewer.ts";

// Mount imperatively into a plain div rather than using `<ClientOnly>` +
// `ref` on the custom element directly. Same reasoning as `DocsMetaAgent.vue`:
// VitePress's `<ClientOnly>` doesn't reliably forward refs into its slot, and
// an SSR'd `<docs-canvas-viewer>` tag inside the Vue template confuses
// hydration. A plain `<div>` SSRs cleanly and we own create/append/teardown.
const containerRef = ref<HTMLDivElement | null>(null);
let host: DocsCanvasViewer | null = null;
let abortController: AbortController | null = null;
let disposed = false;

const props = withDefaults(
  defineProps<{
    src?: string;
  }>(),
  {
    src: "architecture.canvas",
  },
);

onMounted(async () => {
  disposed = false;
  await import("./docs-canvas-viewer.ts"); // registers <docs-canvas-viewer>
  if (disposed) return;

  const container = containerRef.value;
  if (!container) return;

  const Ctor = customElements.get("docs-canvas-viewer") as unknown as
    | (new () => DocsCanvasViewer)
    | undefined;
  if (!Ctor) {
    container.textContent = "Failed to register <docs-canvas-viewer> custom element.";
    return;
  }
  const viewer = new Ctor();
  host = viewer;
  container.appendChild(viewer);

  // BASE_URL always ends in `/` (Vite convention). Canvas files live under
  // docs/public/ and are copied to the site root by VitePress.
  const controller = new AbortController();
  abortController = controller;
  try {
    const resp = await fetch(`${import.meta.env.BASE_URL}${props.src}`, {
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    const doc = (await resp.json()) as ArchitectureCanvasDoc;
    if (disposed || host !== viewer) return;
    viewer.doc = doc;
  } catch (err) {
    if ((err as Error).name === "AbortError" || disposed || host !== viewer) {
      return;
    }
    // Replace the host with an inline error message — same UX shape as
    // DocsMetaAgent's "Failed to register" path. Keeps the failure visible
    // rather than rendering an empty canvas.
    if (viewer.parentElement) viewer.parentElement.removeChild(viewer);
    host = null;
    container.textContent = `Failed to load architecture map: ${(err as Error).message}`;
  } finally {
    if (abortController === controller) {
      abortController = null;
    }
  }
});

onBeforeUnmount(() => {
  disposed = true;
  abortController?.abort();
  abortController = null;
  if (host?.parentElement) host.parentElement.removeChild(host);
  host = null;
});
</script>
