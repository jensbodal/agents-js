#!/usr/bin/env bun
import { runForeground } from "./process-utils.ts";
import { getMissingBuildOutputs } from "./workspace-config.ts";

function collectWorkspaceRoots(relativePaths: string[]): string[] {
  return [
    ...new Set(
      relativePaths.map((relativePath) => {
        const [scope, name] = relativePath.split("/");
        return scope && name ? `${scope}/${name}` : relativePath;
      }),
    ),
  ];
}

export async function ensureWorkspaceBuildOutputs(): Promise<void> {
  const missing = getMissingBuildOutputs();
  const useCache = missing.length === 0;

  if (useCache) {
    console.log("[build] All tracked build outputs are present. Running cached recursive build.");
  } else {
    console.log(
      "[build] Missing tracked build outputs detected. Forcing uncached recursive build:",
    );
    for (const entry of missing) {
      console.log(`- ${entry.relativePath} (${entry.label})`);
    }
  }

  await runForeground(
    useCache
      ? ["vp", "run", "--cache", "-w", "repo:build:graph"]
      : ["vp", "run", "--no-cache", "-w", "repo:build:graph"],
  );

  const missingAfterGraph = getMissingBuildOutputs();
  if (missingAfterGraph.length === 0) {
    return;
  }

  const workspaces = collectWorkspaceRoots(missingAfterGraph.map((entry) => entry.relativePath));
  console.log("[build] Repairing missing workspace outputs after recursive build:");
  for (const workspace of workspaces) {
    console.log(`- ${workspace}`);
    await runForeground(["bun", "run", "--cwd", workspace, "build"]);
  }

  const stillMissing = getMissingBuildOutputs();
  if (stillMissing.length > 0) {
    throw new Error(
      `Missing build outputs after repair: ${stillMissing.map((entry) => entry.relativePath).join(", ")}`,
    );
  }
}

async function main(): Promise<void> {
  await ensureWorkspaceBuildOutputs();
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
