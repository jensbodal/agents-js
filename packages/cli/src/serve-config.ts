/**
 * Config resolution and persistence helpers for `agents-js serve`.
 *
 * Extracted from serve.ts to separate config I/O concerns from
 * the serve orchestration logic.
 */

import {
  type AgentsJsConfig,
  type AgentsJsConfigPaths,
  type GatewayRuntimeSelection,
  mergeAgentsJsConfig,
  writeAgentsJsConfig,
} from "@agents-js/gateway-runtime";
import type { PersistMode } from "./serve-prompts.ts";

export interface ResolvedServeInputs {
  configPaths: AgentsJsConfigPaths;
  host: string;
  persistMode: PersistMode;
  port: number;
  runtimeSelection: GatewayRuntimeSelection;
  projectConfig?: AgentsJsConfig;
  userConfig?: AgentsJsConfig;
}

export function makePersistedServeConfig(
  currentConfig: AgentsJsConfig | undefined,
  resolved: ResolvedServeInputs,
): AgentsJsConfig {
  return mergeAgentsJsConfig(currentConfig, {
    serve: {
      harness: resolved.persistMode === "ask-each-time" ? undefined : resolved.runtimeSelection,
      host: resolved.host,
      port: resolved.port,
      selectionPolicy: resolved.persistMode === "ask-each-time" ? "ask-each-time" : "prefer-saved",
    },
  });
}

/**
 * Write the resolved serve configuration to the appropriate config file
 * based on the user's persist mode selection.
 */
export async function persistServeInputs(
  resolved: ResolvedServeInputs,
  output: Pick<NodeJS.WriteStream, "write">,
): Promise<void> {
  const { persistMode, configPaths, userConfig, projectConfig } = resolved;

  if (persistMode === "user") {
    await writeAgentsJsConfig(
      configPaths.userConfigPath,
      makePersistedServeConfig(userConfig, resolved),
    );
    output.write(`[agents-js] Saved defaults to ${configPaths.userConfigPath}\n`);
  } else if (persistMode === "project") {
    await writeAgentsJsConfig(
      configPaths.projectConfigPath,
      makePersistedServeConfig(projectConfig, resolved),
    );
    output.write(`[agents-js] Saved defaults to ${configPaths.projectConfigPath}\n`);
  } else if (persistMode === "ask-each-time") {
    await writeAgentsJsConfig(
      configPaths.userConfigPath,
      makePersistedServeConfig(userConfig, resolved),
    );
    output.write(`[agents-js] Saved "ask each time" policy to ${configPaths.userConfigPath}\n`);
  }
}
