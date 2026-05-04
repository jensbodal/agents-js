import { defineConfig } from "vite-plus";

function buildInput(prefix: string) {
  return [{ auto: true }, `!${prefix}/dist/**`] as const;
}

export default defineConfig({
  run: {
    cache: {
      scripts: false,
      tasks: true,
    },
    tasks: {
      "repo:doctor": {
        command: "bun scripts/doctor.ts",
        cache: false,
      },
      "repo:build": {
        command: "bun scripts/build.ts",
        cache: false,
      },
      "repo:build:graph": {
        command: `bun -e "console.log('[repo:build] graph complete')"`,
        dependsOn: [
          "app:web-ui:build",
          "pkg:agui-types:build",
          "pkg:a2ui-types:build",
          "pkg:a2ui-renderer:build",
          "pkg:a2ui-host:build",
          "pkg:cli:build",
          "pkg:droid-acp:build",
          "pkg:gateway-runtime:build",
          "pkg:host:build",
          "pkg:mcp-bridge:build",
          "pkg:pi-acp:build",
          "pkg:plane:build",
          "pkg:reporting:build",
          "pkg:skills:build",
          "pkg:tools:build",
        ],
      },
      "repo:dev": {
        command: "bun scripts/dev.ts",
        cache: false,
      },
      "repo:dev:gateway": {
        command: "vp run @agents-js/gateway#dev",
        cache: false,
      },
      "repo:dev:web": {
        command: "vp run @agents-js/web-ui#dev",
        cache: false,
      },
      "repo:browser:smoke": {
        command:
          "bun scripts/browser-smoke.ts --out-dir output/playwright/browser-smoke --command-name browser:smoke --ui-port 4173",
        dependsOn: ["pkg:a2a:build"],
        cache: false,
      },
      "repo:e2e:gateway": {
        command: "bun scripts/e2e-gateway.ts",
        cache: false,
      },
      "repo:e2e:runtime": {
        command: "bun scripts/e2e-runtime.ts",
        cache: false,
      },
      "repo:e2e:web:live": {
        command: "bun scripts/web-ui-live-e2e.ts",
        cache: false,
      },
      "repo:e2e:deterministic": {
        command: "bun scripts/e2e-deterministic.ts",
        cache: false,
      },
      "repo:e2e": {
        command: "bun scripts/e2e.ts",
        cache: false,
      },
      "pkg:policy:build": {
        command: "bun run build",
        cwd: "packages/policy",
        input: buildInput("packages/policy"),
      },
      "pkg:agui-types:build": {
        command: "bun run build",
        cwd: "packages/agui-types",
        input: buildInput("packages/agui-types"),
      },
      "pkg:a2ui-types:build": {
        command: "bun run build",
        cwd: "packages/a2ui-types",
        input: buildInput("packages/a2ui-types"),
      },
      "pkg:a2ui-renderer:build": {
        command: "bun run build",
        cwd: "packages/a2ui-renderer",
        dependsOn: ["pkg:a2ui-types:build", "pkg:ui-components:build"],
        input: buildInput("packages/a2ui-renderer"),
      },
      "pkg:a2ui-host:build": {
        command: "bun run build",
        cwd: "packages/a2ui-host",
        dependsOn: [
          "pkg:acp-host:build",
          "pkg:a2ui-types:build",
          "pkg:ui-components:build",
          "pkg:validation:build",
        ],
        input: buildInput("packages/a2ui-host"),
      },
      "pkg:validation:build": {
        command: "bun run build",
        cwd: "packages/validation",
        dependsOn: ["pkg:policy:build"],
        input: buildInput("packages/validation"),
      },
      "pkg:schema-utils:build": {
        command: "bun run build",
        cwd: "packages/schema-utils",
        input: buildInput("packages/schema-utils"),
      },
      "pkg:skills:build": {
        command: "bun run build",
        cwd: "packages/skills",
        input: buildInput("packages/skills"),
      },
      "pkg:acp:build": {
        command: "bun run build",
        cwd: "packages/acp",
        dependsOn: ["pkg:policy:build"],
        input: buildInput("packages/acp"),
      },
      "pkg:acp-host:build": {
        command: "bun run build",
        cwd: "packages/acp-host",
        dependsOn: ["pkg:acp:build", "pkg:policy:build"],
        input: buildInput("packages/acp-host"),
      },
      "pkg:a2a:build": {
        command: "bun run build",
        cwd: "packages/a2a",
        dependsOn: ["pkg:acp:build", "pkg:policy:build", "pkg:validation:build"],
        input: buildInput("packages/a2a"),
      },
      "pkg:a2a-client:build": {
        command: "bun run build",
        cwd: "packages/a2a-client",
        dependsOn: ["pkg:validation:build"],
        input: buildInput("packages/a2a-client"),
      },
      "pkg:gateway-runtime:build": {
        command: "bun run build",
        cwd: "packages/gateway-runtime",
        dependsOn: ["pkg:acp-host:build", "pkg:a2a:build"],
        input: buildInput("packages/gateway-runtime"),
      },
      "pkg:cli:build": {
        command: "bun run build",
        cwd: "packages/cli",
        dependsOn: [
          "pkg:a2a-client:build",
          "pkg:acp:build",
          "pkg:acp-host:build",
          "pkg:a2a:build",
          "pkg:gateway-runtime:build",
          "pkg:schema-utils:build",
        ],
        input: buildInput("packages/cli"),
      },
      "pkg:mcp-bridge:build": {
        command: "bun run build",
        cwd: "packages/mcp-bridge",
        dependsOn: ["pkg:a2a-client:build"],
        input: buildInput("packages/mcp-bridge"),
      },
      "pkg:pi-acp:build": {
        command: "bun run build",
        cwd: "extras/pi-acp",
        dependsOn: ["pkg:acp:build", "pkg:gateway-runtime:build"],
        input: buildInput("extras/pi-acp"),
      },
      "pkg:droid-acp:build": {
        command: "bun run build",
        cwd: "extras/droid-acp",
        dependsOn: ["pkg:acp:build", "pkg:gateway-runtime:build"],
        input: buildInput("extras/droid-acp"),
      },
      "pkg:plane:build": {
        command: "bun run build",
        cwd: "extras/plane",
        dependsOn: ["pkg:gateway-runtime:build"],
        input: buildInput("extras/plane"),
      },
      "pkg:host:build": {
        command: "bun run build",
        cwd: "packages/host",
        dependsOn: [
          "pkg:a2a:build",
          "pkg:a2a-client:build",
          "pkg:a2ui-host:build",
          "pkg:a2ui-types:build",
          "pkg:acp:build",
          "pkg:acp-host:build",
          "pkg:agui-types:build",
          "pkg:gateway-runtime:build",
          "pkg:validation:build",
        ],
        input: buildInput("packages/host"),
      },
      "pkg:reporting:build": {
        command: "bun run build",
        cwd: "extras/reporting",
        input: buildInput("extras/reporting"),
      },
      "pkg:tools:build": {
        command: "bun run build",
        cwd: "packages/tools",
        input: buildInput("packages/tools"),
      },
      "pkg:ui-components:build": {
        command: "bun run build",
        cwd: "packages/ui-components",
        dependsOn: ["pkg:schema-utils:build"],
        input: buildInput("packages/ui-components"),
      },
      "app:web-ui:build": {
        command: "bun run build",
        cwd: "apps/web-ui",
        dependsOn: ["pkg:a2a-client:build", "pkg:ui-components:build"],
        input: buildInput("apps/web-ui"),
      },

      // ── Test tasks ───────────────────────────────────────────────
      "pkg:policy:test": {
        command: "bun test",
        cwd: "packages/policy",
        dependsOn: ["pkg:policy:build"],
        input: buildInput("packages/policy"),
      },
      "pkg:agui-types:test": {
        command: "bun test",
        cwd: "packages/agui-types",
        dependsOn: ["pkg:agui-types:build"],
        input: buildInput("packages/agui-types"),
      },
      "pkg:a2ui-types:test": {
        command: "bun test",
        cwd: "packages/a2ui-types",
        dependsOn: ["pkg:a2ui-types:build"],
        input: buildInput("packages/a2ui-types"),
      },
      "pkg:a2ui-renderer:test": {
        command: "bun test",
        cwd: "packages/a2ui-renderer",
        dependsOn: ["pkg:a2ui-renderer:build"],
        input: buildInput("packages/a2ui-renderer"),
      },
      "pkg:a2ui-host:test": {
        command: "bun test",
        cwd: "packages/a2ui-host",
        dependsOn: ["pkg:a2ui-host:build"],
        input: buildInput("packages/a2ui-host"),
      },
      "pkg:validation:test": {
        command: "bun test",
        cwd: "packages/validation",
        dependsOn: ["pkg:validation:build"],
        input: buildInput("packages/validation"),
      },
      "pkg:schema-utils:test": {
        command: "bun test",
        cwd: "packages/schema-utils",
        dependsOn: ["pkg:schema-utils:build"],
        input: buildInput("packages/schema-utils"),
      },
      "pkg:skills:test": {
        command: "bun test",
        cwd: "packages/skills",
        dependsOn: ["pkg:skills:build"],
        input: buildInput("packages/skills"),
      },
      "pkg:acp:test": {
        command: "bun test",
        cwd: "packages/acp",
        dependsOn: ["pkg:acp:build"],
        input: buildInput("packages/acp"),
      },
      "pkg:acp-host:test": {
        command: "bun test",
        cwd: "packages/acp-host",
        dependsOn: ["pkg:acp-host:build"],
        input: buildInput("packages/acp-host"),
      },
      "pkg:a2a:test": {
        command: "bun test",
        cwd: "packages/a2a",
        dependsOn: ["pkg:a2a:build"],
        input: buildInput("packages/a2a"),
      },
      "pkg:a2a-client:test": {
        command: "bun test",
        cwd: "packages/a2a-client",
        dependsOn: ["pkg:a2a-client:build"],
        input: buildInput("packages/a2a-client"),
      },
      "pkg:cli:test": {
        command: "bun test",
        cwd: "packages/cli",
        dependsOn: ["pkg:cli:build"],
        input: buildInput("packages/cli"),
      },
      "pkg:gateway-runtime:test": {
        command: "bun test",
        cwd: "packages/gateway-runtime",
        dependsOn: ["pkg:gateway-runtime:build"],
        input: buildInput("packages/gateway-runtime"),
      },
      "pkg:host:test": {
        command: "bun test",
        cwd: "packages/host",
        dependsOn: ["pkg:host:build"],
        input: buildInput("packages/host"),
      },
      "pkg:reporting:test": {
        command: "bun test",
        cwd: "extras/reporting",
        dependsOn: ["pkg:reporting:build"],
        input: buildInput("extras/reporting"),
      },
      "pkg:tools:test": {
        command: "bun test",
        cwd: "packages/tools",
        dependsOn: ["pkg:tools:build"],
        input: buildInput("packages/tools"),
      },
      "pkg:ui-components:test": {
        command: "bun test",
        cwd: "packages/ui-components",
        dependsOn: ["pkg:ui-components:build"],
        input: buildInput("packages/ui-components"),
      },
      "app:web-ui:test": {
        command: "bun test",
        cwd: "apps/web-ui",
        dependsOn: ["app:web-ui:build"],
        input: buildInput("apps/web-ui"),
      },
      "app:internal-gateway:test": {
        command: "bun test",
        cwd: "apps/internal-gateway",
        dependsOn: [
          "pkg:a2a:build",
          "pkg:a2a-client:build",
          "pkg:acp-host:build",
          "pkg:gateway-runtime:build",
          "pkg:host:build",
        ],
        input: buildInput("apps/internal-gateway"),
      },

      // ── Aggregate tasks ──────────────────────────────────────────
      "repo:test": {
        command: `bun -e "console.log('[repo:test] all tests passed')"`,
        dependsOn: [
          "pkg:policy:test",
          "pkg:agui-types:test",
          "pkg:a2ui-types:test",
          "pkg:a2ui-renderer:test",
          "pkg:a2ui-host:test",
          "pkg:validation:test",
          "pkg:schema-utils:test",
          "pkg:skills:test",
          "pkg:acp:test",
          "pkg:acp-host:test",
          "pkg:a2a:test",
          "pkg:a2a-client:test",
          "pkg:cli:test",
          "pkg:gateway-runtime:test",
          "pkg:host:test",
          "pkg:reporting:test",
          "pkg:tools:test",
          "pkg:ui-components:test",
          "app:web-ui:test",
          "app:internal-gateway:test",
        ],
      },
    },
  },
});
