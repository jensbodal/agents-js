/**
 * Histoire setup file.
 *
 * Imports the pre-built `dist/` artifact (not `src/`) so the decorator-bearing
 * sources are already transpiled to plain ES2022 before vite-node tries to
 * load them. Loading `src/index.ts` directly hits a `SyntaxError` because
 * vite-node's SSR transform passes TC39 decorators through unchanged and
 * Node's `vm` cannot parse the `@(...)` form.
 *
 * `stories:build` therefore depends on `dist/` being current — the
 * package-level `stories:build` script runs `bun run build` first so a
 * stale `dist/` does not silently produce stories with outdated component
 * behavior.
 */
import type { App } from "vue";

export const setupVue3 = async (_payload: { app: App }) => {
  // The barrel side-effect-imports every `@safeCustomElement`-decorated
  // module, registering each `acp-*` custom element before any story
  // renders.
  await import("../dist/index.mjs");
};
