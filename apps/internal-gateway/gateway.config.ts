import { type GatewayRuntimeId, parseEnv } from "@agents-js/gateway-runtime";

export interface GatewayConfig {
  runtime: GatewayRuntimeId;
  /** Default model to apply when a session starts. Must match a model ID the agent advertises. */
  defaultModel?: string;
}

// Sourced from env vars (Bun auto-loads .env). See .env.example for expected vars.
// The repo keeps a checked-in default runtime of "opencode" for local dev/test flows.
export const gatewayConfig = {
  runtime: parseEnv("AJS_DEFAULT_HARNESS", "opencode").string() as GatewayRuntimeId,
  defaultModel: parseEnv("AJS_DEFAULT_MODEL").optional().string(),
} satisfies GatewayConfig;
