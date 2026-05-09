#!/usr/bin/env node

import { runAgentsJsCli } from "./cli.ts";
import { EXIT_ERROR, EXIT_OK } from "./exit-codes.ts";

try {
  const exitCode = await runAgentsJsCli(process.argv.slice(2));
  if (exitCode !== EXIT_OK) {
    process.exit(exitCode);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_ERROR);
}
