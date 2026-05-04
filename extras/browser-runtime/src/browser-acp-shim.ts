export type JsonRpcId = string | number;

export type JsonRpcMessage =
  | { jsonrpc: "2.0"; id: JsonRpcId; method: string; params?: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | {
      jsonrpc: "2.0";
      id?: JsonRpcId;
      error: { code: number; message: string; data?: unknown };
    }
  | { jsonrpc: "2.0"; method: string; params?: unknown };

export interface PromptParams {
  sessionId: string;
  input: string;
}

export interface PromptRunner {
  runPrompt(params: PromptParams, emit: (msg: JsonRpcMessage) => void): Promise<void>;
  cancel(sessionId: string): void;
}

function isPromptParams(v: unknown): v is PromptParams {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).sessionId === "string" &&
    typeof (v as Record<string, unknown>).input === "string"
  );
}

function isCancelParams(v: unknown): v is { sessionId: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).sessionId === "string"
  );
}

export class BrowserACPShim {
  constructor(
    private readonly runner: PromptRunner,
    private readonly emit: (msg: JsonRpcMessage) => void,
  ) {}

  async handle(msg: JsonRpcMessage): Promise<void> {
    if (!("method" in msg) || !("id" in msg)) return;
    // After the guard above, msg is narrowed to the request variant
    // ({ jsonrpc, id, method, params? }).
    const id = msg.id;
    const method = msg.method;
    switch (method) {
      case "initialize":
        this.emit({
          jsonrpc: "2.0",
          id,
          result: { capabilities: { streaming: true, structuredActions: true } },
        });
        return;
      case "session/new":
        this.emit({
          jsonrpc: "2.0",
          id,
          result: { sessionId: crypto.randomUUID() },
        });
        return;
      case "session/prompt": {
        if (!isPromptParams(msg.params)) {
          this.emit({
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "invalid params for session/prompt" },
          });
          return;
        }
        try {
          await this.runner.runPrompt(msg.params, this.emit);
          this.emit({ jsonrpc: "2.0", id, result: { ok: true } });
        } catch (err) {
          this.emit({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32603,
              message: (err as Error).message ?? "runner error",
              data: { name: (err as Error).name },
            },
          });
        }
        return;
      }
      case "session/cancel": {
        if (!isCancelParams(msg.params)) {
          this.emit({
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "invalid params for session/cancel" },
          });
          return;
        }
        this.runner.cancel(msg.params.sessionId);
        this.emit({ jsonrpc: "2.0", id, result: { ok: true } });
        return;
      }
      default:
        this.emit({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown method: ${method}` },
        });
    }
  }
}
