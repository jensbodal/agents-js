import { defineConfig } from "vite-plus";
import {
  createWorkspaceBuildTaskNames,
  createWorkspaceBuildTasks,
  createWorkspaceTestTaskNames,
  createWorkspaceTestTasks,
} from "./scripts/workspace-metadata.ts";

const buildTasks = createWorkspaceBuildTasks();
const testTasks = createWorkspaceTestTasks();

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
        dependsOn: createWorkspaceBuildTaskNames(),
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
      ...buildTasks,
      ...testTasks,
      "repo:test": {
        command: `bun -e "console.log('[repo:test] all tests passed')"`,
        dependsOn: createWorkspaceTestTaskNames(),
      },
    },
  },
});
