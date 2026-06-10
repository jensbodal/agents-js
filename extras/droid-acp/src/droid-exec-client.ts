import { type ChildProcess, spawn } from "node:child_process";
import { NDJSONLineBuffer } from "@agents-js/acp";
import type { DroidStreamEvent } from "./types.ts";

/**
 * Per-invocation handle to a spawned `droid exec` child. Unlike a long-lived
 * interactive adapter, each ACP prompt turn spawns one fresh child, streams
 * its NDJSON stdout until the process exits, and then releases the handle.
 *
 * Droid's `exec` subcommand is non-interactive by design — the CLI surface
 * does not expose a stdin-driven multi-turn JSON-RPC mode at the version
 * targeted here. Turn-to-turn continuity is achieved by threading droid's
 * `session_id` back into each subsequent spawn via `--session-id`, not by
 * re-using a process.
 */
export interface DroidExecClientOptions {
  /** Droid binary to spawn. Defaults to `"droid"` — resolved against PATH. */
  command?: string;
  /** Prompt text for this turn. Passed as a positional argv to droid exec. */
  prompt: string;
  /** Working directory for the droid process. Forwarded via `--cwd`. */
  cwd?: string;
  /**
   * Droid session id carried over from a prior turn. When present, forwarded
   * as `--session-id <id>` so droid reloads conversation history before
   * processing `prompt`. Omit on the first turn of an ACP session.
   */
  sessionId?: string;
  /**
   * Autonomy level. Droid defaults to a strict read-only mode that blocks
   * every mutating tool; operators who want the adapter to act as a code
   * assistant typically set this to `"medium"` or `"high"`. Omit to keep
   * droid's default (safest).
   */
  autonomy?: "low" | "medium" | "high";
  /** Extra env vars merged onto the inherited env (on top of FACTORY_API_KEY). */
  env?: Record<string, string>;
  /** Extra argv appended after the base exec flags. */
  extraArgs?: readonly string[];
  /**
   * Full argv override (after the binary path). When provided, replaces the
   * default exec flag sequence entirely — the prompt must be embedded in
   * `argvOverride`. Primarily an escape hatch for tests that drive a non-
   * droid binary (a JS fixture) as the child.
   */
  argvOverride?: readonly string[];
  /** Called for each decoded NDJSON stream event. */
  onEvent: (event: DroidStreamEvent) => void;
  /** Called once when the child exits. */
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  /**
   * Called for malformed stdout lines. Droid is expected to emit valid JSON
   * from byte 0, so any failure is logged at debug level without crashing.
   */
  onProtocolError?: (rawLine: string, error: unknown) => void;
}

/** One spawned `droid exec` child. Represents a single ACP prompt turn. */
export class DroidExecClient {
  private readonly child: ChildProcess;
  private readonly buffer = new NDJSONLineBuffer();
  private readonly onEvent: (event: DroidStreamEvent) => void;
  private readonly onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  private readonly onProtocolError: (rawLine: string, error: unknown) => void;
  private exited = false;

  constructor(options: DroidExecClientOptions) {
    const command = options.command ?? "droid";
    const args = options.argvOverride ? [...options.argvOverride] : buildDroidExecArgs(options);

    // `detached: true` on Unix puts droid into its own process group so we
    // can signal the whole group (including any shells droid spawns for its
    // Execute tool) via `process.kill(-pid, ...)`. Grandchildren must not be
    // orphaned to init on host shutdown. On Windows, `detached: true` opens
    // a new console — gate off-platform.
    const isUnix = process.platform !== "win32";
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      // biome-ignore lint/style/noProcessEnv: droid inherits the live parent env (FACTORY_API_KEY plus any XDG/HOME state that droid reads for its local session cache).
      env: { ...process.env, ...(options.env ?? {}) },
      cwd: options.cwd,
      detached: isUnix,
    });

    if (!child.stdout) {
      throw new Error("[droid-acp] Failed to obtain stdout from spawned droid process");
    }

    this.child = child;
    this.onEvent = options.onEvent;
    this.onExit = options.onExit;
    this.onProtocolError = options.onProtocolError ?? (() => {});

    child.stdout.on("data", (chunk: Buffer) => this.handleStdoutChunk(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      // Mirror droid stderr to our own stderr for operator visibility. Droid
      // itself keeps stderr quiet in stream-json mode; anything here is noteworthy.
      process.stderr.write(chunk);
    });
    child.on("exit", (code, signal) => this.handleExit(code, signal));
    child.on("error", (err) => {
      this.onProtocolError("<spawn-error>", err);
      if (!this.exited) {
        this.handleExit(null, null);
      }
    });

    // Exec mode does not consume stdin for prompts (the prompt is a positional
    // argv). Close stdin eagerly so droid doesn't wait on it during startup.
    child.stdin?.end();
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
      this.onProtocolError(line, new Error("non-object JSON event"));
      return;
    }
    const event = parsed as DroidStreamEvent;
    if (typeof event.type !== "string") {
      this.onProtocolError(line, new Error("missing event type discriminator"));
      return;
    }
    this.onEvent(event);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    const tail = this.buffer.drain();
    if (tail.length > 0) {
      this.onProtocolError(tail, new Error("unterminated line at child exit"));
    }
    this.onExit({ code, signal });
  }

  /**
   * Terminate the droid child. On Unix, signals the whole process group so
   * grandchildren (bash / Execute tool invocations) are cleaned up. On
   * Windows, falls back to `child.kill()`.
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

/**
 * Build the argv sequence passed to `droid` after the binary name, for the
 * standard exec flow. Exposed for testing so the ordering contract can be
 * asserted without spawning a real child.
 */
export function buildDroidExecArgs(options: DroidExecClientOptions): string[] {
  const args: string[] = ["exec", "--output-format", "stream-json"];
  if (options.sessionId) {
    args.push("--session-id", options.sessionId);
  }
  if (options.cwd) {
    args.push("--cwd", options.cwd);
  }
  if (options.autonomy) {
    args.push("--auto", options.autonomy);
  }
  if (options.extraArgs) {
    args.push(...options.extraArgs);
  }
  // Prompt is positional and MUST come last so droid doesn't treat argv that
  // happens to look flag-shaped as part of the prompt.
  args.push(options.prompt);
  return args;
}
