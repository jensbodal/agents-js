import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface WorkspaceBuildOutput {
  label: string;
  relativePath: string;
}

interface WorkspaceTsconfig {
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
}

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const workspaceTsconfigPath = path.join(repoRoot, "tsconfig.workspace.json");

export const workspaceBuildOutputs: WorkspaceBuildOutput[] = [
  { label: "@agents-js/agui-types", relativePath: "packages/agui-types/dist/index.mjs" },
  { label: "@agents-js/a2ui-types", relativePath: "packages/a2ui-types/dist/index.mjs" },
  { label: "@agents-js/a2ui-renderer", relativePath: "packages/a2ui-renderer/dist/index.mjs" },
  { label: "@agents-js/a2ui-host", relativePath: "packages/a2ui-host/dist/index.mjs" },
  {
    label: "@agents-js/a2ui-host/acp-host",
    relativePath: "packages/a2ui-host/dist/acp-host/index.mjs",
  },
  { label: "@agents-js/policy", relativePath: "packages/policy/dist/index.mjs" },
  { label: "@agents-js/validation", relativePath: "packages/validation/dist/index.mjs" },
  { label: "@agents-js/schema-utils", relativePath: "packages/schema-utils/dist/index.mjs" },
  { label: "@agents-js/skills", relativePath: "packages/skills/dist/index.mjs" },
  { label: "@agents-js/acp", relativePath: "packages/acp/dist/index.mjs" },
  { label: "@agents-js/acp-host", relativePath: "packages/acp-host/dist/index.mjs" },
  { label: "@agents-js/acp-host/editor", relativePath: "packages/acp-host/dist/editor/index.mjs" },
  { label: "@agents-js/a2a", relativePath: "packages/a2a/dist/index.mjs" },
  { label: "@agents-js/a2a-client", relativePath: "packages/a2a-client/dist/index.mjs" },
  { label: "@agents-js/a2a-client/node", relativePath: "packages/a2a-client/dist/node.mjs" },
  { label: "@agents-js/cli", relativePath: "packages/cli/dist/index.mjs" },
  { label: "@agents-js/gateway-runtime", relativePath: "packages/gateway-runtime/dist/index.mjs" },
  { label: "@agents-js/host", relativePath: "packages/host/dist/index.mjs" },
  { label: "@agents-js/host/testing", relativePath: "packages/host/dist/testing.mjs" },
  { label: "@agents-js/mcp-bridge", relativePath: "packages/mcp-bridge/dist/index.mjs" },
  { label: "@agents-js/plane", relativePath: "extras/plane/dist/index.mjs" },
  { label: "@agents-js/plane/mount", relativePath: "extras/plane/dist/mount.mjs" },
  { label: "@agents-js/pi-acp", relativePath: "extras/pi-acp/dist/index.mjs" },
  { label: "@agents-js/pi-acp binary", relativePath: "extras/pi-acp/dist/pi-acp" },
  { label: "@agents-js/droid-acp", relativePath: "extras/droid-acp/dist/index.mjs" },
  { label: "@agents-js/droid-acp binary", relativePath: "extras/droid-acp/dist/droid-acp" },
  { label: "@agents-js/reporting", relativePath: "extras/reporting/dist/index.mjs" },
  { label: "@agents-js/tools", relativePath: "packages/tools/dist/index.mjs" },
  { label: "@agents-js/ui-components", relativePath: "packages/ui-components/dist/index.mjs" },
  { label: "@agents-js/web-ui", relativePath: "apps/web-ui/dist/index.html" },
  { label: "compiled CLI binary", relativePath: "packages/cli/dist/agents-js" },
];

function readWorkspaceTsconfig(): WorkspaceTsconfig {
  return JSON.parse(readFileSync(workspaceTsconfigPath, "utf8")) as WorkspaceTsconfig;
}

export function loadWorkspaceSourceAliases(keys?: string[]): Record<string, string> {
  const tsconfig = readWorkspaceTsconfig();
  const baseUrl = tsconfig.compilerOptions?.baseUrl ?? ".";
  const paths = tsconfig.compilerOptions?.paths ?? {};
  const requested = keys ?? Object.keys(paths);
  const aliases: Record<string, string> = {};

  for (const specifier of requested) {
    let firstTarget = paths[specifier]?.[0];
    if (!firstTarget) {
      for (const [pattern, targets] of Object.entries(paths)) {
        if (!pattern.includes("*")) {
          continue;
        }
        const [prefix = "", suffix = ""] = pattern.split("*", 2);
        if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
          continue;
        }
        const wildcardValue = specifier.slice(prefix.length, specifier.length - suffix.length);
        const candidateTarget = targets[0];
        if (!candidateTarget) {
          continue;
        }
        firstTarget = candidateTarget.replace("*", wildcardValue);
        break;
      }
    }
    if (!firstTarget) {
      continue;
    }

    aliases[specifier] = path.resolve(repoRoot, baseUrl, firstTarget);
  }

  return aliases;
}

export function getMissingBuildOutputs(): WorkspaceBuildOutput[] {
  return workspaceBuildOutputs.filter((entry) => {
    return !existsSync(path.join(repoRoot, entry.relativePath));
  });
}
