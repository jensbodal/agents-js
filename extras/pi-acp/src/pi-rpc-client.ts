import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { NDJSONLineBuffer } from "@agents-js/acp";
import type { PiRpcEvent, PiRpcMessage, PiRpcRequest, PiRpcResponse } from "./types.ts";

/**
 * Per-process handle to a spawned Pi CLI in `--mode rpc`. One handle wraps
 * one Pi child; the adapter maintains a 1:1 mapping between ACP sessions and
 * Pi processes (Pi's session id is a per-process concept).
 */
export interface PiRpcClientOptions {
  /** Pi binary to spawn. Defaults to "pi" — resolved against PATH. */
  command?: string;
  /** Extra argv appended after `--mode rpc`. */
  extraArgs?: readonly string[];
  /**
   * Full argv override. When provided, replaces the default `["--mode", "rpc",
   * ...extraArgs]` argv entirely. Primarily an escape hatch for tests that
   * drive a non-Pi binary (a JS fixture) as the child — production callers
   * should pass `extraArgs` and leave `argvOverride` unset.
   */
  argvOverride?: readonly string[];
  /** Working directory for the Pi process (inherits from parent when omitted). */
  cwd?: string;
  /** Extra env vars merged onto the inherited env. */
  env?: Record<string, string>;
  /** Handler invoked for each decoded Pi RPC message. */
  onMessage: (message: PiRpcMessage) => void;
  /** Handler invoked once when the Pi child exits (either intentionally or due to error). */
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  /**
   * Handler for malformed stdout lines. Receives the raw line and the parse
   * error. The adapter currently logs these at debug level — Pi is expected
   * to emit valid JSON from byte 0, so any failure is a protocol bug worth
   * surfacing but not crashing on.
   */
  onProtocolError?: (rawLine: string, error: unknown) => void;
}

/** A spawned Pi RPC client. Represents one Pi child process. */
export class PiRpcClient {
  private readonly child: ChildProcess;
  private readonly buffer = new NDJSONLineBuffer();
  private readonly onMessage: (message: PiRpcMessage) => void;
  private readonly onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  private readonly onProtocolError: (rawLine: string, error: unknown) => void;
  private nextId = 1;
  private readonly pendingResponses = new Map<
    string,
    { resolve: (response: PiRpcResponse) => void; reject: (error: Error) => void }
  >();
  private exited = false;

  constructor(options: PiRpcClientOptions) {
    const command = resolvePiCommand(options.command);
    const args = options.argvOverride
      ? [...options.argvOverride]
      : ["--mode", "rpc", ...(options.extraArgs ?? [])];

    // `detached: true` on Unix puts the child in its own process group so we
    // can signal the whole group (including any shells Pi spawns for bash
    // tool calls) via `process.kill(-pid, ...)`. The same rationale used in
    // `@agents-js/acp`'s `spawnACPAgent`: grandchildren must not be orphaned
    // to init on host shutdown. On Windows, `detached: true` opens a new
    // console — gate off-platform.
    const isUnix = process.platform !== "win32";
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      argv0: path.basename(command),
      // biome-ignore lint/style/noProcessEnv: the Pi child inherits the live parent environment (Pi's auth/config are read from HOME, XDG_*, and other inherited vars).
      env: { ...process.env, ...(options.env ?? {}) },
      cwd: options.cwd,
      detached: isUnix,
    });

    if (!child.stdin || !child.stdout) {
      throw new Error("[pi-acp] Failed to obtain stdin/stdout from spawned Pi process");
    }

    this.child = child;
    this.onMessage = options.onMessage;
    this.onExit = options.onExit;
    this.onProtocolError = options.onProtocolError ?? (() => {});

    child.stdout.on("data", (chunk: Buffer) => this.handleStdoutChunk(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      // Mirror Pi stderr to our own stderr for operator visibility. Pi itself
      // keeps stderr quiet in rpc mode; anything here is noteworthy.
      process.stderr.write(chunk);
    });
    child.on("exit", (code, signal) => this.handleExit(code, signal));
    child.on("error", (err) => {
      this.onProtocolError("<spawn-error>", err);
      if (!this.exited) {
        this.handleExit(null, null);
      }
    });
  }

  private handleStdoutChunk(chunk: Buffer): void {
    const lines = this.buffer.push(chunk);
    for (const line of lines) {
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this.onProtocolError(line, err);
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.onProtocolError(line, new Error("non-object JSON message"));
      return;
    }
    const message = parsed as PiRpcMessage;
    if (message.type === "response") {
      const response = message as PiRpcResponse;
      if (response.id !== undefined) {
        const pending = this.pendingResponses.get(response.id);
        if (pending) {
          this.pendingResponses.delete(response.id);
          if (response.success) {
            pending.resolve(response);
          } else {
            pending.reject(
              new Error(response.error ?? `Pi rpc command "${response.command}" failed`),
            );
          }
        }
      }
      // Still surface to message handler so the translator can observe responses
      // (e.g. to correlate `get_state` data) without hijacking the request API.
      this.onMessage(response);
      return;
    }
    this.onMessage(message as PiRpcEvent);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    // Flush any tail bytes as a debug signal — they are almost always empty in practice.
    const tail = this.buffer.drain();
    if (tail.length > 0) {
      this.onProtocolError(tail, new Error("unterminated line at child exit"));
    }
    // Reject every outstanding request so callers unwind cleanly.
    for (const [, pending] of this.pendingResponses) {
      pending.reject(new Error("Pi process exited before response"));
    }
    this.pendingResponses.clear();
    this.onExit({ code, signal });
  }

  /**
   * Send a request without waiting for correlated response. Safe for fire-and-
   * forget commands (`abort`, notifications). `id` is omitted when not
   * provided; pass an explicit id when you want to observe a reply via the
   * message handler.
   */
  send(request: PiRpcRequest): void {
    if (this.exited) {
      throw new Error("[pi-acp] Cannot send to an exited Pi process");
    }
    const line = `${JSON.stringify(request)}\n`;
    this.child.stdin?.write(line);
  }

  /**
   * Send a request and await its correlated response. Generates an id if one
   * is not supplied. Resolves with the response on `success: true`; rejects
   * with an `Error` carrying Pi's `error` field on `success: false`.
   */
  async sendAndAwait(request: PiRpcRequest): Promise<PiRpcResponse> {
    if (this.exited) {
      throw new Error("[pi-acp] Cannot send to an exited Pi process");
    }
    const id = request.id ?? `pi-acp-${this.nextId++}`;
    const payload: PiRpcRequest = { ...request, id };
    return new Promise<PiRpcResponse>((resolve, reject) => {
      this.pendingResponses.set(id, { resolve, reject });
      try {
        this.send(payload);
      } catch (err) {
        this.pendingResponses.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Terminate the Pi child. On Unix, signals the whole process group so
   * grandchildren (bash tool invocations, etc.) are cleaned up. On Windows,
   * falls back to `child.kill()`.
   */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.exited) return;
    const isUnix = process.platform !== "win32";
    if (isUnix && this.child.pid !== undefined) {
      try {
        process.kill(-this.child.pid, signal);
        return;
      } catch {
        /* process-group already dead */
      }
    }
    try {
      this.child.kill(signal);
    } catch {
      /* already dead */
    }
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get isExited(): boolean {
    return this.exited;
  }
}

function resolvePiCommand(command: string | undefined): string {
  if (command) {
    return command;
  }
  // biome-ignore lint/style/noProcessEnv: operator-controlled escape hatch for shim managers whose executable dispatch depends on argv[0].
  return process.env.PI_ACP_PI_COMMAND || "pi";
}
