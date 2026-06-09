import { join } from "node:path";
import {
  FileCursorStore,
  type GatewayInboxClient,
  HttpGatewayInboxClient,
  type InboxMessage,
  runInboxPoller,
} from "@agents-js/gateway-inbox-runtime";
import { type ClaudeRunner, ClaudeSpawnRunner } from "./claude-runner.ts";
import { runKeyCommand } from "./key-command.ts";
import { formatInboxRowForClaude } from "./prompt-format.ts";
import { type SenderAllowlist, senderAllowed } from "./sender-allowlist.ts";

export interface ReceiverLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ClaudeGatewayInboxReceiverOptions {
  readonly identity: string;
  readonly gatewayUrl: string;
  readonly workspace: string;
  readonly keyCommand: string;
  readonly client?: GatewayInboxClient;
  readonly runner?: ClaudeRunner;
  readonly fetchImpl?: typeof fetch;
  readonly fetchMode?: string;
  readonly cursorPath?: string;
  readonly intervalMs?: number;
  readonly limit?: number;
  readonly claudeCommand?: string;
  readonly claudeArgs?: readonly string[];
  readonly mcpConfigPath: string;
  readonly mcpCommand?: string;
  readonly mcpArgs?: readonly string[];
  readonly senderAllowlist?: SenderAllowlist;
  readonly signal: AbortSignal;
  readonly logger?: ReceiverLogger;
}

export async function runClaudeGatewayInboxReceiver(
  options: ClaudeGatewayInboxReceiverOptions,
): Promise<void> {
  const logger = options.logger ?? console;
  const client =
    options.client ??
    new HttpGatewayInboxClient({
      baseUrl: options.gatewayUrl,
      entity: options.identity,
      getPrivateKeyPem: () => runKeyCommand(options.keyCommand),
      fetchImpl: options.fetchImpl,
    });
  const runner =
    options.runner ??
    new ClaudeSpawnRunner({
      command: options.claudeCommand,
      args: options.claudeArgs,
      cwd: options.workspace,
      mcpConfigPath: options.mcpConfigPath,
      identity: options.identity,
      gatewayUrl: options.gatewayUrl,
      keyCommand: options.keyCommand,
      fetchMode: options.fetchMode,
      mcpCommand: options.mcpCommand,
      mcpArgs: options.mcpArgs,
    });
  const cursorPath =
    options.cursorPath ??
    join(options.workspace, ".agents", options.identity, "claude-gateway-inbox-cursor.json");
  try {
    await runInboxPoller({
      client,
      identity: options.identity,
      cursorStore: new FileCursorStore(cursorPath),
      signal: options.signal,
      intervalMs: options.intervalMs,
      limit: options.limit,
      logger,
      onMessage: (row) =>
        deliverRow({
          row,
          runner,
          senderAllowlist: options.senderAllowlist,
          logger,
        }),
    });
  } finally {
    await client.close();
  }
}

export interface DeliverClaudeRowOptions {
  readonly row: InboxMessage;
  readonly runner: ClaudeRunner;
  readonly senderAllowlist?: SenderAllowlist;
  readonly logger: ReceiverLogger;
}

export async function deliverRow(options: DeliverClaudeRowOptions): Promise<void> {
  const formatted = formatInboxRowForClaude(options.row);
  if (!senderAllowed(formatted.senderIdentity, options.senderAllowlist)) {
    options.logger.warn(
      `sender-not-allowlisted message_id=${options.row.message_id} sender=${formatted.senderIdentity}`,
    );
    return;
  }
  options.logger.log(`delivering message_id=${options.row.message_id}`);
  await options.runner.run(formatted.prompt);
}
