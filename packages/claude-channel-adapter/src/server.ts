/**
 * MCP server impl: declares the `claude/channel` + `claude/channel/permission`
 * experimental capabilities, exposes `agents_js_reply` + `agents_js_send`
 * outbound tools, dispatches `notifications/claude/channel` frames.
 *
 * **Critique-first reasoning (boundaries/defaults/contracts/safety/validation)**
 *
 * - **Boundary**: this module is the ONLY place where MCP server primitives
 *   are constructed. Caller-supplied `gatewayEmit` callback handles the
 *   outbound side (CC → mesh); caller drives `emitChannelMessage` for the
 *   inbound side (gateway → CC). Both sides terminate at this module's seam.
 * - **Default**: stdio transport (matches mcp-bus-bridge precedent + Claude
 *   Code's launch-time `.mcp.json` integration). Caller can override with
 *   any `Transport` from the MCP SDK if they need HTTP+SSE later.
 * - **Contract**: {@link emitChannelMessage} runs the sanitizer + sender-gate
 *   in series; if either rejects, the emit is dropped and the caller gets a
 *   typed error result. Outbound tool handlers translate `CallTool` requests
 *   into `gatewayEmit` calls; the gateway-emit shape is caller-defined to
 *   keep this module decoupled from any specific gateway adapter.
 * - **Safety**: sender-gate is REQUIRED — no default allowlist; caller must
 *   construct one explicitly. Hyphen-drop sanitizer runs at every emit;
 *   failures throw (per sanitizer default).
 * - **Validation**: integration tests cover capability handshake echo,
 *   tool-list registration, sanitizer/gate composition, and stdio transport
 *   smoke. Live Claude Code harness integration is hostname-null-claude-0's
 *   lane.
 *
 * **Outbound tool registration**
 *
 * Two tools registered: `agents_js_reply` (context-bearing reply, typically
 * threaded back to the source sender) and `agents_js_send` (free-form send
 * to a target identifier). Tool input schemas are minimal in v1 — caller's
 * gateway-emit callback owns higher-level validation. Future expansion to
 * `agents_js_send_quorum` (AJS-67 recipient-intent) tracked separately.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type SanitizedMeta, sanitizeMetaForChannel } from "./meta-sanitizer.ts";
import type { SenderGate } from "./sender-gate.ts";

/** Method name for the Channels protocol inbound push. */
export const CLAUDE_CHANNEL_METHOD = "notifications/claude/channel";

/** Outbound tool: context-bearing reply (typically threaded to source sender). */
export const TOOL_REPLY = "agents_js_reply";
/** Outbound tool: free-form send to a target identifier. */
export const TOOL_SEND = "agents_js_send";

/**
 * Result of an outbound `agents_js_*` tool invocation, returned to Claude
 * Code by the MCP `CallTool` handler. Stays minimal in v1; richer typing
 * lands when AJS-XX (typed MatrixTool send-failure shape) finalizes.
 */
export interface GatewayEmitResult {
  readonly ok: boolean;
  readonly detail?: string;
}

/** Caller-supplied gateway emit callback for outbound (CC → mesh) tool calls. */
export interface GatewayEmit {
  /**
   * Invoked by the `agents_js_reply` tool handler.
   * @param target Identifier of the original sender being replied to, or
   *   `undefined` to let the adapter route to the most-recent inbound
   *   sender (the relay `sender` in the `<channel>` tag is not routable).
   * @param content Reply text payload.
   */
  reply(target: string | undefined, content: string): Promise<GatewayEmitResult>;
  /**
   * Invoked by the `agents_js_send` tool handler.
   * @param target Identifier of the send recipient (free-form).
   * @param content Send text payload.
   */
  send(target: string, content: string): Promise<GatewayEmitResult>;
}

/** Options for {@link createClaudeChannelServer}. */
export interface CreateClaudeChannelServerOptions {
  /** Server identity advertised on the MCP `initialize` handshake. */
  readonly serverInfo: { name: string; version: string };
  /**
   * Sender-agent-identity gate. Required — there is no default allowlist
   * (deny-closed for the prompt-injection surface).
   */
  readonly senderGate: SenderGate;
  /**
   * Caller-supplied gateway-emit callback for outbound tool calls.
   * Adapter forwards `agents_js_reply` / `agents_js_send` invocations here.
   */
  readonly gatewayEmit: GatewayEmit;
  /**
   * Optional `instructions` string injected into Claude Code's system
   * prompt at session boot. Per Channels protocol, this is delivered with
   * the capability handshake.
   */
  readonly instructions?: string;
}

/** Result of an attempted {@link ClaudeChannelServer.emitChannelMessage}. */
export type EmitResult =
  | { readonly status: "emitted" }
  | { readonly status: "rejected-by-sender-gate"; readonly sender: string }
  | { readonly status: "rejected-by-sanitizer"; readonly reason: string };

/** Handle returned from {@link createClaudeChannelServer}. */
export interface ClaudeChannelServer {
  /** Connect to the supplied transport. Defaults to stdio. */
  connect(transport?: Transport): Promise<void>;
  /**
   * Emit a `notifications/claude/channel` frame into the connected
   * transport. Runs the sender-gate and meta sanitizer in series; either
   * rejection short-circuits and returns a typed result without invoking
   * the transport.
   */
  emitChannelMessage(input: {
    readonly content: string;
    readonly sender: string;
    readonly meta?: Readonly<Record<string, unknown>>;
  }): Promise<EmitResult>;
  /** Close the transport and release resources. */
  close(): Promise<void>;
}

/**
 * Build the Claude Code channel-adapter MCP server. Caller invokes
 * `connect()` to attach a transport (defaults to stdio), then
 * `emitChannelMessage(...)` per inbound gateway wake/inbox event.
 */
export function createClaudeChannelServer(
  options: CreateClaudeChannelServerOptions,
): ClaudeChannelServer {
  const { serverInfo, senderGate, gatewayEmit, instructions } = options;

  const server = new Server(serverInfo, {
    capabilities: {
      // Capability handshake is what opts Claude Code into the
      // `notifications/claude/channel` method-specific listener.
      // Empty objects mark "present" per Channels protocol.
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
      tools: {},
    },
    ...(instructions !== undefined ? { instructions } : {}),
  });

  // -- Outbound tool registration ------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: TOOL_REPLY,
        description:
          "Reply to the agent that pushed the most-recent <channel> message into this session. Omit target and the adapter routes the reply to that sender automatically; the <channel> tag's own sender is the relay and is NOT a valid target.",
        inputSchema: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description:
                "Optional override of the reply recipient. Leave unset to reply to the most-recent inbound sender (the meta.reply_to the adapter resolved); set it only to direct the reply elsewhere.",
            },
            content: {
              type: "string",
              description: "Reply text payload.",
            },
          },
          required: ["content"],
        },
      },
      {
        name: TOOL_SEND,
        description:
          "Send a free-form message to a target identifier (any mesh-reachable agent or room).",
        inputSchema: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "Recipient identifier — agent name, room id, etc.",
            },
            content: {
              type: "string",
              description: "Message text payload.",
            },
          },
          required: ["target", "content"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const target = typeof args?.target === "string" ? args.target : undefined;
    const content = typeof args?.content === "string" ? args.content : undefined;

    if (content === undefined) {
      return {
        content: [{ type: "text", text: `tool "${name}" requires a string "content" argument` }],
        isError: true,
      };
    }

    let result: GatewayEmitResult;
    if (name === TOOL_REPLY) {
      // `target` is optional — when omitted the adapter resolves the
      // most-recent inbound sender (the <channel> relay is not routable).
      result = await gatewayEmit.reply(target, content);
    } else if (name === TOOL_SEND) {
      if (target === undefined) {
        return {
          content: [
            { type: "text", text: `tool "${TOOL_SEND}" requires a string "target" argument` },
          ],
          isError: true,
        };
      }
      result = await gatewayEmit.send(target, content);
    } else {
      return {
        content: [{ type: "text", text: `unknown tool "${name}"` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: result.ok ? "ok" : (result.detail ?? "gateway emit failed"),
        },
      ],
      isError: !result.ok,
    };
  });

  // -- Lifecycle -----------------------------------------------------------

  let connected = false;

  return {
    async connect(transport?: Transport): Promise<void> {
      if (connected) return;
      const actual = transport ?? new StdioServerTransport();
      await server.connect(actual);
      connected = true;
    },
    async emitChannelMessage(input): Promise<EmitResult> {
      if (!connected) {
        throw new Error(
          "createClaudeChannelServer.emitChannelMessage: connect() must be called first",
        );
      }

      if (!senderGate.allow(input.sender)) {
        return { status: "rejected-by-sender-gate", sender: input.sender };
      }

      let sanitized: SanitizedMeta;
      try {
        sanitized = sanitizeMetaForChannel({
          // SENDER-SPOOFING DEFENSE (hostname-null-claude-0 live smoke
          // 2026-05-28, matrix
          // $91CJLzvbFuM073MDKi_gpa7hK486hzHZiDRy69Yezao):
          // spread caller-supplied meta FIRST, then layer the
          // gate-passed `sender` on top so a malicious or buggy
          // caller-supplied `meta.sender` CANNOT override the value
          // that passed the sender-gate. The reversed shape
          // `{sender, ...input.meta}` would let untrusted meta override
          // the source attribute in the rendered `<channel source=…>`
          // tag, defeating the gate.
          // Sender is routed through meta so the sanitizer normalizes
          // its key shape consistently with operator-supplied keys.
          ...(input.meta ?? {}),
          sender: input.sender,
        });
      } catch (err: unknown) {
        return {
          status: "rejected-by-sanitizer",
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      await server.notification({
        method: CLAUDE_CHANNEL_METHOD,
        params: {
          content: input.content,
          meta: sanitized,
        },
      });

      return { status: "emitted" };
    },
    async close(): Promise<void> {
      if (!connected) return;
      await server.close();
      connected = false;
    },
  };
}
