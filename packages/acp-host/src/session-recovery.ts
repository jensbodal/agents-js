import type { StartConfig } from "./types/adapters.ts";

/**
 * Detect opencode's "default agent not found" error shape. opencode returns
 * JSON-RPC `-32603` (Internal error) with `data.details` matching
 * `default agent "<name>" not found` when the configured default agent slug
 * cannot be located at session-create time.
 */
const OPENCODE_DEFAULT_AGENT_MISSING_PATTERN = /default agent "(.+)" not found/;

export function isOpencodeDefaultAgentMissing(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const code = (err as { code?: unknown }).code;
  if (code !== -32603) return null;
  const details = (err as { data?: { details?: unknown } }).data?.details;
  if (typeof details !== "string") return null;
  const match = details.match(OPENCODE_DEFAULT_AGENT_MISSING_PATTERN);
  return match?.[1] ?? null;
}

export function createOpencodeDefaultAgentRecoveredConfig(
  previousConfig: StartConfig,
): StartConfig {
  return {
    ...previousConfig,
    agentConfig: {
      ...previousConfig.agentConfig,
      args: [...previousConfig.agentConfig.args, "--pure"],
    },
  };
}
