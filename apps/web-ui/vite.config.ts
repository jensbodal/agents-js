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
    // The reference UI ships as a multi-entry bundle: the main chat app
    // (index.html / src/main.ts) and the AJS-85 agent inbox browser
    // (inbox.html / src/inbox.ts) are independent surfaces.
    // Keep the warning budget aligned with the current bundled workspace deps.
    chunkSizeWarningLimit: 1_200,
    rollupOptions: {
      input: {
        main: resolve(configDir, "index.html"),
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
    ],
  },
  server: {
    port: 5173,
    // Allow non-localhost hostnames for reference UI runs behind a gateway or
    // reverse proxy. Operators can tighten this in their own deployment config.
    allowedHosts: true,
    proxy: defaultTargetProxy
      ? {
          "/.well-known": defaultTargetProxy,
          "/jsonrpc": defaultTargetProxy,
        }
      : undefined,
  },
});
