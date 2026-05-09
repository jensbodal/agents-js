import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { PiRpcClient } from "./pi-rpc-client.ts";
import { PiToAcpTranslator } from "./translator.ts";
import type { PiRpcMessage } from "./types.ts";

/**
 * Per-session wiring between the ACP `AgentSideConnection` and one Pi child.
 *
 * One ACP session == one Pi process. The session owns the Pi RPC client, the
 * translator, and the lifecycle hooks for an outstanding prompt turn.
 */
export interface PiAcpSessionOptions {
  /** ACP session id, chosen by this adapter and returned to the ACP client. */
  sessionId: string;
  /** Bound back-reference so the session can emit `session/update` notifications. */
  connection: AgentSideConnection;
  /** Working directory for the Pi child. Usually the ACP `NewSessionRequest.cwd`. */
  cwd?: string;
  /** Optional override for the Pi binary name. */
  piCommand?: string;
  /** Optional extra argv passed to Pi after `--mode rpc`. */
  piExtraArgs?: readonly string[];
}

export class PiAcpSession {
  readonly sessionId: string;
  private readonly connection: AgentSideConnection;
  private readonly translator: PiToAcpTranslator;
  private readonly client: PiRpcClient;
  /** Resolver for the currently in-flight `prompt` request. */
  private pendingPrompt: {
    resolve: (value: {
      stopReason: "end_turn" | "cancelled" | "max_tokens" | "max_turn_requests" | "refusal";
    }) => void;
    reject: (err: Error) => void;
  } | null = null;
  private exited = false;

  constructor(options: PiAcpSessionOptions) {
    this.sessionId = options.sessionId;
    this.connection = options.connection;
    this.translator = new PiToAcpTranslator(options.sessionId);

    this.client = new PiRpcClient({
      command: options.piCommand,
      extraArgs: options.piExtraArgs,
      cwd: options.cwd,
      onMessage: (message) => this.handlePiMessage(message),
      onExit: (info) => this.handlePiExit(info),
      onProtocolError: (raw, err) => {
        // Pi is documented to emit clean JSON from byte 0; any protocol
        // error here is a real upstream bug. Log to stderr with enough
        // context to diagnose without crashing the adapter.
        process.stderr.write(
          `[pi-acp] Pi RPC protocol error (session=${this.sessionId}): ${String(err)}\n`,
        );
        if (raw) {
          process.stderr.write(`[pi-acp] offending line: ${raw.slice(0, 512)}\n`);
        }
      },
    });
  }

  /**
   * Forward an ACP `session/prompt` request into Pi and wait for the turn to
   * complete. Streams intermediate content out via `AgentSideConnection.sessionUpdate`.
   */
  async prompt(message: string): Promise<{
    stopReason: "end_turn" | "cancelled" | "max_tokens" | "max_turn_requests" | "refusal";
  }> {
    if (this.pendingPrompt) {
      throw new Error(
        `[pi-acp] Session ${this.sessionId} already has a prompt in flight; ACP clients must await each prompt before issuing another.`,
      );
    }
    if (this.exited) {
      throw new Error(`[pi-acp] Session ${this.sessionId} has exited; cannot issue a new prompt.`);
    }
    this.translator.markTurnStarted();
    return new Promise<{
      stopReason: "end_turn" | "cancelled" | "max_tokens" | "max_turn_requests" | "refusal";
    }>((resolve, reject) => {
      this.pendingPrompt = { resolve, reject };
      try {
        this.client.send({ type: "prompt", message });
      } catch (err) {
        this.pendingPrompt = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Handle an ACP `session/cancel` notification. Forwards Pi's `abort` RPC
   * and resolves any outstanding prompt with `cancelled` when Pi acknowledges.
   */
  cancel(): void {
    if (this.exited) return;
    try {
      this.client.send({ type: "abort" });
    } catch {
      // Pi already gone — fall through; handlePiExit will reject the pending prompt.
    }
    // Eagerly resolve the prompt promise as cancelled so ACP clients observe
    // the cancellation without waiting for Pi's agent_end event. The Pi
    // child will continue emitting the tail of its stream; subsequent
    // notifications are safe to forward on the same session.
    const pending = this.pendingPrompt;
    if (pending) {
      this.pendingPrompt = null;
      this.translator.markTurnCancelled();
      pending.resolve({ stopReason: "cancelled" });
    }
  }

  /** Tear down the Pi process and flush session state. */
  close(): void {
    if (this.exited) return;
    this.client.kill();
  }

  /** Translate one Pi RPC stream event into ACP notifications and forward them. */
  private handlePiMessage(message: PiRpcMessage): void {
    const step = this.translator.handleMessage(message);
    for (const notification of step.notifications) {
      // Fire-and-forget — `sessionUpdate` returns a Promise but ACP has no
      // back-pressure contract here; we just log failures.
      this.connection.sessionUpdate(notification).catch((err: unknown) => {
        process.stderr.write(
          `[pi-acp] sessionUpdate failed (session=${this.sessionId}): ${String(err)}\n`,
        );
      });
    }
    if (step.turnComplete) {
      const pending = this.pendingPrompt;
      if (pending) {
        this.pendingPrompt = null;
        pending.resolve({ stopReason: step.turnComplete.stopReason });
      }
    }
  }

  private handlePiExit(info: { code: number | null; signal: NodeJS.Signals | null }): void {
    this.exited = true;
    const pending = this.pendingPrompt;
    if (pending) {
      this.pendingPrompt = null;
      // Prefer `refusal` over a custom string so the stopReason remains in
      // the ACP union. Operators investigating an unexpected exit will see
      // the stderr log line emitted by the adapter.
      pending.reject(
        new Error(
          `Pi process exited before turn completed (code=${info.code ?? "null"}, signal=${info.signal ?? "null"})`,
        ),
      );
    }
  }
}
