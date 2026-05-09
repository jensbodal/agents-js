import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { DroidExecClient, type DroidExecClientOptions } from "./droid-exec-client.ts";
import { DroidToAcpTranslator } from "./translator.ts";
import type { DroidStreamEvent } from "./types.ts";

/**
 * Per-session wiring between the ACP `AgentSideConnection` and droid.
 *
 * Droid does not expose a long-lived interactive ACP-compatible mode; its
 * `exec` subcommand is one-shot non-interactive. The adapter therefore
 * implements an ACP "session" as a sequence of per-turn `droid exec`
 * invocations, threading droid's internal `session_id` from one turn to
 * the next via `--session-id` so conversation history is preserved.
 *
 * Session-lived state:
 *  - `cwd` — forwarded as `--cwd` on every turn
 *  - `droidSessionId` — captured from droid's `system/init` event on the
 *    first turn and reused on subsequent turns
 *  - `activeClient` — handle to the currently-running child (set while a
 *    prompt turn is in flight; cleared at turn end)
 */
export interface DroidAcpSessionOptions {
  /** ACP session id, chosen by this adapter and returned to the ACP client. */
  sessionId: string;
  /** Bound back-reference so the session can emit `session/update` notifications. */
  connection: AgentSideConnection;
  /** Working directory for droid. Usually the ACP `NewSessionRequest.cwd`. */
  cwd?: string;
  /** Optional override for the droid binary name. */
  droidCommand?: string;
  /** Optional default autonomy level applied to every turn. */
  autonomy?: DroidExecClientOptions["autonomy"];
  /** Optional extra argv appended after the base exec flags. */
  droidExtraArgs?: readonly string[];
  /**
   * Factory override — used by tests to swap in a mock child. Defaults to
   * `DroidExecClient` construction.
   */
  clientFactory?: (options: DroidExecClientOptions) => DroidExecClient;
}

export class DroidAcpSession {
  readonly sessionId: string;
  private readonly connection: AgentSideConnection;
  private readonly cwd: string | undefined;
  private readonly droidCommand: string | undefined;
  private readonly autonomy: DroidExecClientOptions["autonomy"] | undefined;
  private readonly droidExtraArgs: readonly string[] | undefined;
  private readonly clientFactory: (options: DroidExecClientOptions) => DroidExecClient;

  /** Carried forward between turns for `--session-id`. */
  private droidSessionId: string | undefined;
  private activeClient: DroidExecClient | null = null;
  private translator: DroidToAcpTranslator | null = null;
  private pendingPrompt: {
    resolve: (value: {
      stopReason: "end_turn" | "cancelled" | "max_tokens" | "max_turn_requests" | "refusal";
    }) => void;
    reject: (err: Error) => void;
  } | null = null;
  private cancelRequested = false;

  constructor(options: DroidAcpSessionOptions) {
    this.sessionId = options.sessionId;
    this.connection = options.connection;
    this.cwd = options.cwd;
    this.droidCommand = options.droidCommand;
    this.autonomy = options.autonomy;
    this.droidExtraArgs = options.droidExtraArgs;
    this.clientFactory = options.clientFactory ?? ((opts) => new DroidExecClient(opts));
  }

  /**
   * Run one prompt turn. Spawns a fresh droid child, streams events through
   * the translator, and resolves when droid emits `completion` (or when the
   * child exits, or when cancellation is requested).
   */
  async prompt(message: string): Promise<{
    stopReason: "end_turn" | "cancelled" | "max_tokens" | "max_turn_requests" | "refusal";
  }> {
    if (this.pendingPrompt) {
      throw new Error(
        `[droid-acp] Session ${this.sessionId} already has a prompt in flight; ACP clients must await each prompt before issuing another.`,
      );
    }
    this.cancelRequested = false;
    this.translator = new DroidToAcpTranslator(this.sessionId);
    this.translator.markTurnStarted();

    return new Promise<{
      stopReason: "end_turn" | "cancelled" | "max_tokens" | "max_turn_requests" | "refusal";
    }>((resolve, reject) => {
      this.pendingPrompt = { resolve, reject };
      try {
        this.activeClient = this.clientFactory({
          command: this.droidCommand,
          prompt: message,
          cwd: this.cwd,
          sessionId: this.droidSessionId,
          autonomy: this.autonomy,
          extraArgs: this.droidExtraArgs,
          onEvent: (event) => this.handleEvent(event),
          onExit: (info) => this.handleExit(info),
          onProtocolError: (raw, err) => {
            process.stderr.write(
              `[droid-acp] stream-json protocol error (session=${this.sessionId}): ${String(err)}\n`,
            );
            if (raw) {
              process.stderr.write(`[droid-acp] offending line: ${raw.slice(0, 512)}\n`);
            }
          },
        });
      } catch (err) {
        this.pendingPrompt = null;
        this.translator = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Handle ACP `session/cancel`. Sends SIGTERM to the active droid
   * process-group so the child (and any Execute-tool grandchildren) unwind
   * promptly. The outstanding prompt promise resolves with `cancelled` as
   * soon as cancellation is observed.
   */
  cancel(): void {
    this.cancelRequested = true;
    const client = this.activeClient;
    if (client && !client.isExited) {
      try {
        client.kill("SIGTERM");
      } catch {
        // process-group already dead; fall through
      }
    }
    const pending = this.pendingPrompt;
    if (pending) {
      this.pendingPrompt = null;
      if (this.translator) {
        this.translator.markTurnCancelled();
      }
      pending.resolve({ stopReason: "cancelled" });
    }
  }

  /** Tear down any in-flight droid child. Safe to call repeatedly. */
  close(): void {
    const client = this.activeClient;
    if (client && !client.isExited) {
      try {
        client.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    }
    this.activeClient = null;
  }

  private handleEvent(event: DroidStreamEvent): void {
    if (!this.translator) {
      return;
    }
    const step = this.translator.handleEvent(event);
    if (step.droidSessionId) {
      // Latch the first observed droid session id for multi-turn continuity.
      this.droidSessionId = step.droidSessionId;
    }
    for (const notification of step.notifications) {
      this.connection.sessionUpdate(notification).catch((err: unknown) => {
        process.stderr.write(
          `[droid-acp] sessionUpdate failed (session=${this.sessionId}): ${String(err)}\n`,
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

  private handleExit(info: { code: number | null; signal: NodeJS.Signals | null }): void {
    this.activeClient = null;
    this.translator = null;
    const pending = this.pendingPrompt;
    if (!pending) {
      return;
    }
    this.pendingPrompt = null;
    if (this.cancelRequested) {
      // Cancellation path: resolve as cancelled rather than reject.
      pending.resolve({ stopReason: "cancelled" });
      return;
    }
    // Unexpected early exit without a completion event — reject so the ACP
    // client sees a concrete error rather than a silent hang.
    pending.reject(
      new Error(
        `droid process exited before completion (code=${info.code ?? "null"}, signal=${info.signal ?? "null"})`,
      ),
    );
  }
}
