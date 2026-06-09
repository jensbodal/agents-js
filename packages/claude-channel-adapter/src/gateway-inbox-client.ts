/**
 * `GatewayInboxClient` — durable-inbox transport for the channel launcher.
 *
 * **Critique-first reasoning (boundaries/defaults/contracts/safety)**
 *
 * - **Boundary**: this module owns the read/write seam against the agents-js
 *   gateway durable inbox. Everything above it (the poll loop, the channel
 *   sink) is transport-agnostic and depends only on the {@link GatewayInboxClient}
 *   interface — so the same poller drives Claude Code today and Codex CLI next,
 *   swapping only the sink, never this client.
 * - **Default**: stdio MCP transport to an `agents-gateway` MCP server (the same
 *   tool surface the Codex app loads — `agents_get_messages` / `agents_send_message`).
 *   The server command + env (identity, gateway URL, credential) is INJECTED, not
 *   hardcoded: the credential a launcher uses is issued by provisioning, never
 *   self-minted here.
 * - **Contract**: `getMessages` reads the JWT-subject's OWN inbox (identity lives
 *   in the minted token, not the request body). `sendMessage` posts as that
 *   subject. The caller-supplied `identity` is echoed back so the poller can
 *   enforce the identity guard (never surface another agent's inbox).
 * - **Safety**: this module performs ZERO credential handling. It spawns a
 *   server that owns minting; if that server is unprovisioned the spawn/list
 *   fails loudly rather than degrading to an insecure path.
 */

import type {
  GatewayInboxClient,
  GetMessagesResult,
  InboxMessage,
  SendMessageResult,
} from "@agents-js/gateway-inbox-runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export type {
  GatewayInboxClient,
  GetMessagesResult,
  InboxMessage,
  MatrixOrigin,
  SendMessageResult,
} from "@agents-js/gateway-inbox-runtime";

/** Spawn config for {@link McpGatewayInboxClient}. Supplied by provisioning. */
export interface McpGatewayInboxClientOptions {
  /** Executable to spawn (e.g. `node`). */
  readonly command: string;
  /** Args — typically the path to the agents-gateway MCP server script. */
  readonly args: string[];
  /**
   * Environment for the spawned server. Carries the credential/identity the
   * server mints with (e.g. `AGENTS_GATEWAY_URL`, the token path, and the
   * default identity). NEVER populated with another agent's credential.
   */
  readonly env?: Record<string, string>;
  /** Client identity advertised on the MCP handshake. */
  readonly clientInfo?: { name: string; version: string };
}

const GET_TOOL = "agents_get_messages";
const SEND_TOOL = "agents_send_message";

/** Parse the `content[0].text` JSON payload an agents-gateway tool returns. */
function parseToolText(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  const first = Array.isArray(content) ? content.find((c) => c?.type === "text") : undefined;
  if (!first?.text) return {};
  try {
    return JSON.parse(first.text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * {@link GatewayInboxClient} backed by an `agents-gateway` MCP server over
 * stdio. Connects lazily on first use. The server owns JWT minting; this class
 * only marshals tool calls and parses their JSON text payloads.
 */
export class McpGatewayInboxClient implements GatewayInboxClient {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(private readonly options: McpGatewayInboxClientOptions) {}

  private async connected(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const transport = new StdioClientTransport({
        command: this.options.command,
        args: this.options.args,
        env: this.options.env,
      });
      const client = new Client(
        this.options.clientInfo ?? { name: "claude-channel-launcher", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(transport);
      this.client = client;
      return client;
    })();
    return this.connecting;
  }

  async getMessages(args: { identity: string; limit?: number }): Promise<GetMessagesResult> {
    const client = await this.connected();
    const out = parseToolText(
      await client.callTool({
        name: GET_TOOL,
        arguments: { identity: args.identity, limit: args.limit ?? 10 },
      }),
    );
    return {
      ok: out.ok === true,
      identity: typeof out.identity === "string" ? out.identity : args.identity,
      messages: Array.isArray(out.messages) ? (out.messages as InboxMessage[]) : [],
    };
  }

  async sendMessage(args: {
    target: string;
    body: string;
    identity: string;
  }): Promise<SendMessageResult> {
    const client = await this.connected();
    const out = parseToolText(
      await client.callTool({
        name: SEND_TOOL,
        arguments: { target: args.target, body: args.body, identity: args.identity },
      }),
    );
    return {
      ok: out.ok === true,
      ...(typeof out.event_id === "string" ? { event_id: out.event_id } : {}),
    };
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.connecting = null;
    if (c) await c.close();
  }
}
