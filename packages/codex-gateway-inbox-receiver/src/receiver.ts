import { join } from "node:path";
import {
  FileCursorStore,
  type GatewayInboxClient,
  HttpGatewayInboxClient,
  type InboxMessage,
  runInboxPoller,
} from "@agents-js/gateway-inbox-runtime";
import { type CodexRunner, type JsonRpcClient, selectCodexRunner } from "./codex-runner.ts";
import { runKeyCommand } from "./key-command.ts";
import { formatInboxRowForCodex } from "./prompt-format.ts";
import { type SenderAllowlist, senderAllowed } from "./sender-allowlist.ts";

export interface ReceiverLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface CodexGatewayInboxReceiverOptions {
  readonly identity: string;
  readonly gatewayUrl: string;
  readonly workspace: string;
  readonly keyCommand: string;
  readonly client?: GatewayInboxClient;
  readonly runner?: CodexRunner;
  readonly appServerClient?: JsonRpcClient;
  readonly fetchImpl?: typeof fetch;
  readonly cursorPath?: string;
  readonly intervalMs?: number;
  readonly limit?: number;
  readonly autoReply?: boolean;
  readonly replyTarget?: string;
  readonly skipGitRepoCheck?: boolean;
  readonly senderAllowlist?: SenderAllowlist;
  readonly signal: AbortSignal;
  readonly logger?: ReceiverLogger;
}

export async function runCodexGatewayInboxReceiver(
  options: CodexGatewayInboxReceiverOptions,
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
  const runner = await selectCodexRunner({
    explicitRunner: options.runner,
    appServerClient: options.appServerClient,
    execRunnerOptions: {
      cwd: options.workspace,
      skipGitRepoCheck: options.skipGitRepoCheck,
    },
    logger,
  });
  const cursorPath =
    options.cursorPath ??
    join(options.workspace, ".agents", options.identity, "gateway-inbox-cursor.json");
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
          client,
          identity: options.identity,
          autoReply: options.autoReply ?? false,
          replyTarget: options.replyTarget,
          senderAllowlist: options.senderAllowlist ?? new Set(),
          logger,
        }),
    });
  } finally {
    await client.close();
  }
}

export interface DeliverRowOptions {
  readonly row: InboxMessage;
  readonly runner: CodexRunner;
  readonly client: GatewayInboxClient;
  readonly identity: string;
  readonly autoReply: boolean;
  readonly replyTarget?: string;
  readonly senderAllowlist: SenderAllowlist;
  readonly logger: ReceiverLogger;
}

export async function deliverRow(options: DeliverRowOptions): Promise<void> {
  const formatted = formatInboxRowForCodex(options.row);
  if (!senderAllowed(formatted.senderIdentity, options.senderAllowlist)) {
    options.logger.warn(
      `sender-not-allowlisted message_id=${options.row.message_id} sender=${formatted.senderIdentity}`,
    );
    return;
  }
  options.logger.log(`delivering message_id=${options.row.message_id}`);
  const result = await options.runner.run(formatted.prompt);
  if (!options.autoReply || !result.reply?.trim()) return;
  const target = formatted.replyTo ?? options.replyTarget;
  if (!target) {
    options.logger.warn(`no-routable-reply-target message_id=${options.row.message_id}`);
    return;
  }
  await options.client.sendMessage({
    target,
    body: result.reply,
    identity: options.identity,
  });
}
