import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { defineConfig } from "vite";
import { loadWorkspaceSourceAliases } from "../../scripts/workspace-config.ts";

/**
 * Vite config for the web-ui reference app.
 *
 * Key fixes:
 * - esbuild.target: "es2022" — transforms TC39 decorators (@customElement, @property)
 *   that vite-plus/esbuild would otherwise pass through raw to the browser
 * - resolve.alias — points workspace packages to source for tree-shaking
 *   (eliminates node:fs/promises from validation's barrel export)
 */
const configDir = fileURLToPath(new URL(".", import.meta.url));
const acpHostSessionRestoreSrc = resolve(
  configDir,
  "../../packages/acp-host/src/session-restore.ts",
);
const acpHostWorkflowSurfaceSrc = resolve(
  configDir,
  "../../packages/acp-host/src/workflow-surface.ts",
);
const connectPreferencesSrc = resolve(
  configDir,
  "../../packages/ui-components/src/connect-preferences-store.ts",
);
const webUiGlueSrc = resolve(configDir, "../../packages/ui-components/src/web-ui-glue.ts");
const uiComponentsSrcDir = resolve(configDir, "../../packages/ui-components/src");
// biome-ignore lint/style/noProcessEnv: Vite evaluates this config in Node, not Bun.
const defaultTargetProxy = process.env.VITE_AGENTS_DEFAULT_TARGET_URL;
// Local-dev source consume of the wasm-canvas renderer (sibling repo, not a
// workspace package). When WASM_CANVAS_SRC points at the wasm-canvas checkout,
// `@q4m/wasm-canvas-renderer` resolves to its TypeScript source so the dashboard
// canvas can be proven before the package is published to Nexus. Unset in
// deployed builds, where the real `@q4m/wasm-canvas-renderer` dep resolves from
// node_modules — so this committed config stays deploy-safe.
// biome-ignore lint/style/noProcessEnv: Vite evaluates this config in Node, not Bun.
const wasmCanvasRepo = process.env.WASM_CANVAS_SRC;
const wasmCanvasSrc = wasmCanvasRepo ? resolve(wasmCanvasRepo, "src/index.ts") : undefined;
const workspaceAliases = loadWorkspaceSourceAliases([
  "@agents-js/a2a-client",
  "@agents-js/a2ui-host",
  "@agents-js/a2ui-renderer",
  "@agents-js/a2ui-types",
  "@agents-js/acp-host",
  "@agents-js/acp-host/editor",
  "@agents-js/policy",
  "@agents-js/schema-utils",
  "@agents-js/ui-components",
  "@agents-js/validation",
]);

function normalizeTransformId(id: string): string {
  const withoutQuery = id.split("?", 1)[0];
  return withoutQuery.startsWith("/@fs/") ? withoutQuery.slice("/@fs".length) : withoutQuery;
}

export default defineConfig({
  build: {
    // The reference UI ships as a multi-entry bundle of independent surfaces:
    // the root gateway dashboard (index.html / src/dashboard-root.ts — live
    // fleet via the Lit renderer + an embedded wasm canvas viz panel), the chat
    // app (chat.html / src/chat.ts), and the AJS-85 agent inbox browser
    // (inbox.html / src/inbox.ts). The dashboard is the front door at `/`; there
    // is no separate `/dashboard` route.
    // Keep the warning budget aligned with the current bundled workspace deps.
    chunkSizeWarningLimit: 1_200,
    rollupOptions: {
      input: {
        main: resolve(configDir, "index.html"),
        chat: resolve(configDir, "chat.html"),
        inbox: resolve(configDir, "inbox.html"),
      },
    },
  },
  plugins: [
    {
      name: "transform-ui-components-decorators",
      enforce: "pre",
      async transform(code: string, id: string) {
        const normalizedId = normalizeTransformId(id);
        if (!normalizedId.startsWith(uiComponentsSrcDir) || !normalizedId.endsWith(".ts")) {
          return null;
        }

        return esbuild.transform(code, {
          loader: "ts",
          format: "esm",
          target: "es2022",
          sourcefile: normalizedId,
          sourcemap: true,
        });
      },
    },
  ],
  esbuild: {
    target: "es2022",
  },
  resolve: {
    alias: [
      { find: "@agents-js/acp-host/session-restore", replacement: acpHostSessionRestoreSrc },
      { find: "@agents-js/acp-host/workflow-surface", replacement: acpHostWorkflowSurfaceSrc },
      { find: "@agents-js/ui-components/connect-preferences", replacement: connectPreferencesSrc },
      { find: "@agents-js/ui-components/web-ui-glue", replacement: webUiGlueSrc },
      ...Object.entries(workspaceAliases).map(([find, replacement]) => ({ find, replacement })),
      ...(wasmCanvasSrc ? [{ find: "@q4m/wasm-canvas-renderer", replacement: wasmCanvasSrc }] : []),
    ],
  },
  server: {
    port: 5173,
    // Allow non-localhost hostnames for reference UI runs behind a gateway or
    // reverse proxy. Operators can tighten this in their own deployment config.
    allowedHosts: true,
    // When source-consuming the wasm-canvas renderer from a sibling repo, vite
    // must be allowed to serve files (incl. the `.wasm` asset) from outside the
    // app root. No-op in deployed builds (WASM_CANVAS_SRC unset).
    ...(wasmCanvasRepo ? { fs: { allow: [resolve(configDir, "../.."), wasmCanvasRepo] } } : {}),
    proxy: defaultTargetProxy
      ? {
          "/.well-known": defaultTargetProxy,
          "/jsonrpc": defaultTargetProxy,
          // The dashboard subscribes to the gateway event bus over SSE; proxy it
          // same-origin so the browser's EventSource needs no CORS/auth dance.
          // `ws:false` keeps it an HTTP stream (SSE, not a websocket upgrade).
          "/events": { target: defaultTargetProxy, ws: false },
        }
      : undefined,
  },
});
