import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { WorkspaceBuildOutput } from "./workspace-metadata.ts";
import { repoRoot, workspaceBuildOutputs } from "./workspace-metadata.ts";

export type { WorkspaceBuildOutput };
export { repoRoot, workspaceBuildOutputs };

interface WorkspaceTsconfig {
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
}

export const workspaceTsconfigPath = path.join(repoRoot, "tsconfig.workspace.json");

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
