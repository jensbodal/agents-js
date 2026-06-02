<template>
  <div ref="containerRef"></div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
// Type-only import keeps the Lit element out of the SSR bundle; the runtime
// side-effect import (registering <docs-capability-map>) happens in onMounted.
// Same pattern as DocsArchitectureMap.vue.
import type { CapabilityStatusDoc, DocsCapabilityMap } from "./docs-capability-map.ts";

const containerRef = ref<HTMLDivElement | null>(null);
let host: DocsCapabilityMap | null = null;
let abortController: AbortController | null = null;
let disposed = false;

const props = withDefaults(
  defineProps<{
    src?: string;
  }>(),
  {
    src: "capability-status.json",
  },
);

onMounted(async () => {
  disposed = false;
  await import("./docs-capability-map.ts"); // registers <docs-capability-map>
  if (disposed) return;

  const container = containerRef.value;
  if (!container) return;

  const Ctor = customElements.get("docs-capability-map") as unknown as
    | (new () => DocsCapabilityMap)
    | undefined;
  if (!Ctor) {
    container.textContent = "Failed to register <docs-capability-map> custom element.";
    return;
  }
  const viewer = new Ctor();
  host = viewer;
  container.appendChild(viewer);

  const controller = new AbortController();
  abortController = controller;
  try {
    const resp = await fetch(`${import.meta.env.BASE_URL}${props.src}`, {
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    const doc = (await resp.json()) as CapabilityStatusDoc;
    if (disposed || host !== viewer) return;
    viewer.data = doc;
  } catch (err) {
    if ((err as Error).name === "AbortError" || disposed || host !== viewer) {
      return;
    }
    if (viewer.parentElement) viewer.parentElement.removeChild(viewer);
    host = null;
    container.textContent = `Failed to load capability map: ${(err as Error).message}`;
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
