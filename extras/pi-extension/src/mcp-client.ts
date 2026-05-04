import type { AgentBridge, AgentTool, ProgressCallback } from "./types.ts";

/**
 * JSON-RPC 2.0 request envelope.
 */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * JSON-RPC 2.0 response envelope.
 */
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Pending request tracker — stores resolve/reject for an in-flight JSON-RPC call.
 */
interface PendingRequest {
  resolve: (value: JsonRpcResponse) => void;
  reject: (reason: Error) => void;
}

/**
 * Configuration for the MCP bridge subprocess.
 */
export interface McpBridgeClientOptions {
  /** Command to run (default: "agents-js") */
  command?: string;
  /** Arguments for the command (default: ["mcp"]) */
  args?: string[];
  /** Request timeout in milliseconds (default: 30000) */
  requestTimeoutMs?: number;
}

/**
 * MCP stdio client that communicates with an `agents-js mcp` subprocess
 * using newline-delimited JSON-RPC 2.0 over stdin/stdout pipes.
 *
 * Implements the {@link AgentBridge} interface for use in the Pi CLI extension.
 */
export class McpBridgeClient implements AgentBridge {
  private readonly command: string;
  private readonly args: string[];
  private readonly requestTimeoutMs: number;

  private process: Bun.Subprocess<"pipe", "pipe", "ignore"> | null = null;
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly decoder = new TextDecoder();
  private lineBuffer = "";
  private readerDone = false;
  /** Cap line buffer at 1 MB to prevent unbounded growth from malformed output. */
  private static readonly MAX_LINE_BUFFER = 1024 * 1024;
  /** Generation counter to prevent stale reader cleanup from rejecting new requests. */
  private generation = 0;

  constructor(options?: McpBridgeClientOptions) {
    this.command = options?.command ?? "agents-js";
    this.args = options?.args ?? ["mcp"];
    this.requestTimeoutMs = options?.requestTimeoutMs ?? 30_000;
  }

  /**
   * Spawn the bridge subprocess and perform the MCP initialize handshake.
   */
  async initialize(): Promise<void> {
    this._spawn();
    await this._performHandshake();
  }

  /**
   * List available tools from the bridge.
   */
  async listTools(): Promise<AgentTool[]> {
    await this._ensureAlive();

    const response = await this._request("tools/list");
    const result = response.result as { tools?: Array<{ name: string; description?: string }> };
    const tools = result?.tools ?? [];

    return tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
    }));
  }

  /**
   * Call a named tool with a message and return the text response.
   */
  async callTool(name: string, message: string, _onProgress?: ProgressCallback): Promise<string> {
    await this._ensureAlive();

    const response = await this._request("tools/call", {
      name,
      arguments: { message },
    });

    const result = response.result as {
      content?: Array<{ type: string; text?: string }>;
    };
    const content = result?.content ?? [];
    const textPart = content.find((c) => c.type === "text");
    return textPart?.text ?? "(no response)";
  }

  /**
   * Kill the bridge subprocess and reject all pending requests.
   */
  async destroy(): Promise<void> {
    this._killProcess();
  }

  // ---------------------------------------------------------------------------
  // Private: subprocess management
  // ---------------------------------------------------------------------------

  private _spawn(): void {
    this.generation++;
    this.process = Bun.spawn<"pipe", "pipe", "ignore">([this.command, ...this.args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });

    this.readerDone = false;
    this.lineBuffer = "";
    this._startReading();
  }

  /**
   * Read stdout in a background loop, buffering lines and dispatching
   * JSON-RPC responses to pending request handlers.
   */
  private _startReading(): void {
    const proc = this.process;
    if (!proc?.stdout) return;

    const reader = proc.stdout.getReader();
    const gen = this.generation;

    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // If generation advanced, this reader is stale — stop silently
          if (this.generation !== gen) return;

          const chunk =
            typeof value === "string" ? value : this.decoder.decode(value, { stream: true });
          this.lineBuffer += chunk;

          if (this.lineBuffer.length > McpBridgeClient.MAX_LINE_BUFFER) {
            this.lineBuffer = "";
            this._rejectAllPending(
              new Error("Line buffer exceeded 1 MB — bridge output malformed"),
            );
            return;
          }

          // Process complete lines
          let newlineIdx = this.lineBuffer.indexOf("\n");
          while (newlineIdx !== -1) {
            const line = this.lineBuffer.slice(0, newlineIdx).trim();
            this.lineBuffer = this.lineBuffer.slice(newlineIdx + 1);

            if (line.length > 0) {
              try {
                const msg = JSON.parse(line) as JsonRpcResponse;
                if (msg.id != null) {
                  const entry = this.pending.get(msg.id);
                  if (entry) {
                    this.pending.delete(msg.id);
                    entry.resolve(msg);
                  }
                }
              } catch {
                // Ignore non-JSON lines (e.g. stderr leaking, debug output)
              }
            }

            newlineIdx = this.lineBuffer.indexOf("\n");
          }
        }
      } catch {
        // Reader error — process likely exited
      } finally {
        // Only reject pending if this reader is still current
        if (this.generation === gen) {
          this.readerDone = true;
          this._rejectAllPending(new Error("Bridge subprocess exited unexpectedly"));
        }
      }
    };

    pump();
  }

  /**
   * Send a JSON-RPC notification (no id, no response expected).
   */
  private _notify(method: string, params?: Record<string, unknown>): void {
    const envelope: JsonRpcRequest = { jsonrpc: "2.0", method };
    if (params) envelope.params = params;
    this._writeToStdin(envelope);
  }

  /**
   * Send a JSON-RPC request and wait for the matching response.
   */
  private _request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = ++this.requestId;
    const envelope: JsonRpcRequest = { jsonrpc: "2.0", id, method };
    if (params) envelope.params = params;

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`Request ${method} (id=${id}) timed out after ${this.requestTimeoutMs}ms`),
        );
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timer);
          reject(reason);
        },
      });
      this._writeToStdin(envelope);
    });
  }

  /**
   * Serialize and write a JSON-RPC envelope to the subprocess stdin.
   */
  private _writeToStdin(envelope: JsonRpcRequest): void {
    if (!this.process?.stdin) {
      throw new Error("Bridge subprocess is not running");
    }
    const line = `${JSON.stringify(envelope)}\n`;
    this.process.stdin.write(line);
  }

  /**
   * Perform the MCP initialize handshake:
   * 1. Send `initialize` request and wait for response
   * 2. Send `notifications/initialized` notification
   */
  private async _performHandshake(): Promise<void> {
    const response = await this._request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pi-extension", version: "0.2.0-beta-3" },
    });

    if (response.error) {
      throw new Error(`MCP initialize failed: ${response.error.message}`);
    }

    this._notify("notifications/initialized");
  }

  /**
   * If the subprocess has died, re-spawn and re-initialize before the next call.
   */
  private async _ensureAlive(): Promise<void> {
    // Check cheap flags first; only fall back to exitCode (a syscall) if needed
    const dead =
      this.process == null ||
      this.readerDone ||
      (!this.readerDone && this.process.exitCode != null);

    if (dead) {
      this._killProcess();
      this._spawn();
      await this._performHandshake();
    }
  }

  /**
   * Kill the subprocess and reject any outstanding promises.
   */
  private _killProcess(): void {
    if (this.process) {
      try {
        this.process.kill();
      } catch {
        // Already dead — ignore
      }
      this.process = null;
    }
    this._rejectAllPending(new Error("Bridge subprocess destroyed"));
  }

  /**
   * Reject all pending requests with the given error.
   */
  private _rejectAllPending(error: Error): void {
    for (const entry of this.pending.values()) {
      entry.reject(error);
    }
    this.pending.clear();
  }
}
