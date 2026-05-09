/**
 * Terminal process lifecycle manager.
 *
 * Spawns processes using direct argv-array invocation (no shell), captures
 * stdout+stderr into a managed buffer with optional byte-limit truncation,
 * and tracks exit status.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { CreateTerminalRequest } from "@agentclientprotocol/sdk";
import {
  type HostEnvPolicyInput,
  type ResolvedHostEnvPolicy,
  resolveHostEnvPolicy,
} from "./env-policy.ts";

export interface ManagedTerminal {
  id: string;
  process: ChildProcess;
  outputBuffer: string;
  outputBytes: number;
  outputByteLimit: number | null;
  truncated: boolean;
  exitStatus: { exitCode: number | null; signal: string | null } | null;
  exitPromise: Promise<{ exitCode: number | null; signal: string | null }>;
}

function buildEnv(
  policy: ResolvedHostEnvPolicy,
  extra?: Array<{ name: string; value: string }>,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of policy.terminalEnvKeys) {
    const val = process.env[key];
    if (val !== undefined) {
      env[key] = val;
    }
  }

  if (extra) {
    for (const { name, value } of extra) {
      if (!policy.forbiddenExtraEnvKeys.has(name)) {
        env[name] = value;
      }
    }
  }

  return env;
}

/**
 * Trim outputBuffer from the beginning so that it fits within the byte limit.
 * Ensures truncation happens at a character boundary (no broken multi-byte chars).
 */
function trimBufferToByteLimit(
  buffer: string,
  byteLimit: number,
): { trimmed: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(buffer);

  if (bytes.length <= byteLimit) {
    return { trimmed: buffer, truncated: false };
  }

  // Slice from the end (keep the most recent output)
  const sliced = bytes.slice(bytes.length - byteLimit);

  // Decode -- TextDecoder with fatal:false replaces broken leading bytes with U+FFFD
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let trimmed = decoder.decode(sliced);

  // Strip any leading replacement characters from broken multi-byte sequences
  while (trimmed.length > 0 && trimmed.charCodeAt(0) === 0xfffd) {
    trimmed = trimmed.slice(1);
  }

  return { trimmed, truncated: true };
}

// `detached: true` makes the spawned process a process-group leader on Unix,
// which lets the `kill`/`release` paths signal the whole group (child +
// grandchildren). User-initiated terminals routinely spawn pipelines and
// subshells; without this, those grandchildren get reparented to init on
// SIGTERM/SIGKILL and keep running. Mirrors createHostACPProcess.
//
// On Windows, `detached: true` opens a new console window, so we gate this
// off platform.
const IS_UNIX = process.platform !== "win32";

/**
 * Send a signal to the whole process group on Unix (pgid === child.pid because
 * of `detached: true`), or fall back to direct child.kill on Windows / when
 * the pid isn't known (e.g. failed to spawn).
 */
function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (IS_UNIX && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* process-group already dead */
    }
    return;
  }
  child.kill(signal);
}

export interface TerminalManagerOptions {
  envPolicy?: HostEnvPolicyInput;
}

export class TerminalManager {
  private terminals = new Map<string, ManagedTerminal>();
  private readonly policy: ResolvedHostEnvPolicy;

  constructor(options: TerminalManagerOptions = {}) {
    this.policy = resolveHostEnvPolicy(options.envPolicy);
  }

  /**
   * Spawn a new terminal process.
   * Caller must have validated params via terminal-policy first.
   */
  create(params: CreateTerminalRequest, defaultCwd: string): string {
    const id = randomUUID();
    const cwd = params.cwd ?? defaultCwd;
    const env = buildEnv(this.policy, params.env);
    const args = params.args ?? [];

    const child = spawn(params.command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      cwd,
      env,
      detached: IS_UNIX,
    });

    let resolveExit!: (status: { exitCode: number | null; signal: string | null }) => void;
    const exitPromise = new Promise<{ exitCode: number | null; signal: string | null }>(
      (resolve) => {
        resolveExit = resolve;
      },
    );

    const terminal: ManagedTerminal = {
      id,
      process: child,
      outputBuffer: "",
      outputBytes: 0,
      outputByteLimit: params.outputByteLimit ?? null,
      truncated: false,
      exitStatus: null,
      exitPromise,
    };

    child.on("exit", (code, signal) => {
      terminal.exitStatus = {
        exitCode: code ?? null,
        signal: signal ?? null,
      };
      resolveExit(terminal.exitStatus);
    });

    child.on("error", (err) => {
      if (!terminal.exitStatus) {
        terminal.exitStatus = { exitCode: 1, signal: null };
        appendOutput(terminal, `Error: ${err.message}\n`);
        resolveExit(terminal.exitStatus);
      }
    });

    // Capture stdout
    child.stdout?.on("data", (chunk: Buffer) => {
      appendOutput(terminal, chunk.toString("utf-8"));
    });

    // Capture stderr
    child.stderr?.on("data", (chunk: Buffer) => {
      appendOutput(terminal, chunk.toString("utf-8"));
    });

    this.terminals.set(id, terminal);
    return id;
  }

  getTerminal(terminalId: string): ManagedTerminal | undefined {
    return this.terminals.get(terminalId);
  }

  getOutput(terminalId: string): {
    output: string;
    truncated: boolean;
    exitStatus: { exitCode: number | null; signal: string | null } | null;
  } {
    const terminal = this.requireTerminal(terminalId);
    return {
      output: terminal.outputBuffer,
      truncated: terminal.truncated,
      exitStatus: terminal.exitStatus,
    };
  }

  async waitForExit(
    terminalId: string,
  ): Promise<{ exitCode: number | null; signal: string | null }> {
    const terminal = this.requireTerminal(terminalId);
    return terminal.exitPromise;
  }

  kill(terminalId: string): void {
    const terminal = this.requireTerminal(terminalId);
    if (!terminal.exitStatus) {
      killProcessGroup(terminal.process, "SIGTERM");
    }
  }

  release(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return; // idempotent
    if (!terminal.exitStatus) {
      killProcessGroup(terminal.process, "SIGKILL");
    }
    this.terminals.delete(terminalId);
  }

  destroyAll(): void {
    for (const [id] of this.terminals) {
      this.release(id);
    }
  }

  private requireTerminal(terminalId: string): ManagedTerminal {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }
    return terminal;
  }
}

function appendOutput(terminal: ManagedTerminal, data: string): void {
  terminal.outputBuffer += data;

  // Incrementally track byte count — only encode the new chunk, not the full buffer.
  const chunkBytes = new TextEncoder().encode(data).length;
  terminal.outputBytes += chunkBytes;

  if (terminal.outputByteLimit != null && terminal.outputBytes > terminal.outputByteLimit) {
    const { trimmed, truncated } = trimBufferToByteLimit(
      terminal.outputBuffer,
      terminal.outputByteLimit,
    );
    terminal.outputBuffer = trimmed;
    // After trimming, re-measure once to reset the running total accurately.
    terminal.outputBytes = new TextEncoder().encode(trimmed).length;
    if (truncated) {
      terminal.truncated = true;
    }
  }
}
