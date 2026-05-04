#!/usr/bin/env bun

import { validateWorkspaceBuildGraph } from "./workspace-metadata.ts";

function printSummary(): void {
  const result = validateWorkspaceBuildGraph();

  if (result.issues.length > 0) {
    console.error("[build-graph] FAIL");
    for (const issue of result.issues) {
      console.error(`- ${issue}`);
    }
    process.exit(1);
  }

  console.log("[build-graph] OK");
  console.log(`- workspaces: ${result.workspaceCount}`);
  console.log(`- build tasks: ${result.buildTaskCount}`);
  console.log(`- test tasks: ${result.testTaskCount}`);
  console.log(`- tracked outputs: ${result.outputCount}`);
}

printSummary();
