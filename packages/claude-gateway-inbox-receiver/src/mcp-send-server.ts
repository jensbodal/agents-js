import {
  type GatewayInboxClient,
  HttpGatewayInboxClient,
  selectFetchImpl,
} from "@agents-js/gateway-inbox-runtime";
import { runKeyCommand } from "./key-command.ts";

export interface McpSendServerOptions {
  readonly identity: string;
  readonly gatewayUrl: string;
  readonly keyCommand: string;
  readonly fetchImpl?: typeof fetch;
  readonly client?: GatewayInboxClient;
  readonly stdin?: McpInputStream;
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
}

interface McpInputStream {
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  resume(): unknown;
}

interface JsonRpcMessage {
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

const tools = [
  {
    name: "agents_send_message",
    description: "Send a Matrix-routed agent message through the AgentsJS gateway.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Gateway target agent name." },
        body: { type: "string", description: "Message body to deliver." },
      },
      required: ["target", "body"],
    },
  },
];

export async function runMcpSendServer(options: McpSendServerOptions): Promise<void> {
  const client =
    options.client ??
    new HttpGatewayInboxClient({
      baseUrl: options.gatewayUrl,
      entity: options.identity,
      getPrivateKeyPem: () => runKeyCommand(options.keyCommand),
      fetchImpl: options.fetchImpl,
    });
  const stdin: McpInputStream = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  const write = (message: unknown): void => {
    const json = JSON.stringify(message);
    stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
  };
  const reply = (id: JsonRpcMessage["id"], result: unknown): void => {
    write({ jsonrpc: "2.0", id, result });
  };
  const replyError = (id: JsonRpcMessage["id"], code: number, message: string): void => {
    write({ jsonrpc: "2.0", id, error: { code, message } });
  };

  const handle = async (message: JsonRpcMessage): Promise<void> => {
    const { id, method, params } = message;
    try {
      if (method === "initialize") {
        reply(id, {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "agents-gateway-send-mcp", version: "0.1.0" },
        });
        return;
      }
      if (method === "notifications/initialized") return;
      if (method === "ping") {
        reply(id, {});
        return;
      }
      if (method === "tools/list") {
        reply(id, { tools });
        return;
      }
      if (method === "tools/call") {
        const result = await callTool(client, options.identity, params);
        reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
        return;
      }
      if (id !== undefined) replyError(id, -32601, `method not found: ${method}`);
    } catch (error) {
      replyError(id, -32000, error instanceof Error ? error.message : String(error));
    }
  };

  await new Promise<void>((resolve, reject) => {
    stdin.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      const decoded = decodeMessages(buffer);
      buffer = decoded.remaining;
      for (const message of decoded.messages) {
        void handle(message);
      }
    });
    stdin.on("error", reject);
    stdin.on("end", resolve);
    stdin.resume();
  }).finally(() => client.close());
}

async function callTool(
  client: GatewayInboxClient,
  identity: string,
  params: Record<string, unknown> | undefined,
): Promise<unknown> {
  if (params?.name !== "agents_send_message")
    throw new Error(`unknown tool: ${String(params?.name)}`);
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  if (typeof args.target !== "string" || typeof args.body !== "string") {
    throw new Error("agents_send_message requires string target and body");
  }
  return client.sendMessage({ target: args.target, body: args.body, identity });
}

function decodeMessages(buffer: Buffer<ArrayBufferLike>): {
  messages: JsonRpcMessage[];
  remaining: Buffer<ArrayBufferLike>;
} {
  const messages: JsonRpcMessage[] = [];
  let current = buffer;
  while (current.length > 0) {
    const headerEnd = current.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = current.subarray(0, headerEnd).toString("utf8");
    const match = /^Content-Length:\s*(\d+)/im.exec(header);
    if (!match) break;
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (current.length < bodyEnd) break;
    const body = current.subarray(bodyStart, bodyEnd).toString("utf8");
    current = current.subarray(bodyEnd);
    messages.push(JSON.parse(body) as JsonRpcMessage);
  }
  return { messages, remaining: current };
}

export function readMcpSendServerEnv(
  env: Record<string, string | undefined>,
): Omit<McpSendServerOptions, "stdin" | "stdout" | "client"> {
  const identity = env.AGENTS_GATEWAY_DEFAULT_IDENTITY ?? env.AGENTS_GATEWAY_SUB;
  const gatewayUrl = env.AGENTS_GATEWAY_URL;
  const keyCommand = env.AGENTS_GATEWAY_KEY_CMD;
  if (!identity || !gatewayUrl || !keyCommand) {
    throw new Error(
      "missing required env: AGENTS_GATEWAY_DEFAULT_IDENTITY/AGENTS_GATEWAY_SUB, AGENTS_GATEWAY_URL, AGENTS_GATEWAY_KEY_CMD",
    );
  }
  return {
    identity,
    gatewayUrl,
    keyCommand,
    fetchImpl: selectFetchImpl(env.AGENTS_GATEWAY_FETCH),
  };
}
