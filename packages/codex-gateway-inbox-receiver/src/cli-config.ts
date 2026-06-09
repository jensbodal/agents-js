import { selectFetchImpl } from "@agents-js/gateway-inbox-runtime";

export interface ReceiverCliConfig {
  readonly identity?: string;
  readonly gatewayUrl?: string;
  readonly workspace: string;
  readonly keyCommand?: string;
  readonly cursorPath?: string;
  readonly intervalMs?: number;
  readonly limit?: number;
  readonly autoReply: boolean;
  readonly replyTarget?: string;
  readonly fetchImpl?: typeof fetch;
}

export function readReceiverCliConfig(
  envSource: Record<string, string | undefined>,
  cwd: string,
): ReceiverCliConfig {
  const env = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = envSource[name];
      if (value) return value;
    }
    return undefined;
  };

  return {
    identity: env("CODEX_GATEWAY_IDENTITY", "AGENTS_GATEWAY_SUB"),
    gatewayUrl: env("CODEX_GATEWAY_URL", "AGENTS_GATEWAY_URL"),
    workspace: env("CODEX_WORKSPACE", "PWD") ?? cwd,
    keyCommand: env("CODEX_GATEWAY_KEY_CMD", "AGENTS_GATEWAY_KEY_CMD"),
    cursorPath: env("CODEX_GATEWAY_CURSOR_PATH"),
    intervalMs: numberEnv(envSource, "CODEX_GATEWAY_POLL_INTERVAL_MS"),
    limit: numberEnv(envSource, "CODEX_GATEWAY_POLL_LIMIT"),
    autoReply: env("CODEX_GATEWAY_AUTO_REPLY") === "true",
    replyTarget: env("CODEX_GATEWAY_REPLY_TARGET"),
    fetchImpl: selectFetchImpl(env("CODEX_GATEWAY_FETCH")),
  };
}

export function missingRequiredReceiverCliEnv(config: ReceiverCliConfig): boolean {
  return !config.identity || !config.gatewayUrl || !config.keyCommand;
}

function numberEnv(
  envSource: Record<string, string | undefined>,
  name: string,
): number | undefined {
  const value = envSource[name];
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
