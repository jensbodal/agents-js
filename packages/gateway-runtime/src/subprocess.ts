/**
 * Canonical `runCommand` helper used by every gateway-runtime adjacent
 * package (`reporting`, `extras`, future call sites). Wraps `Bun.spawn`
 * with composable timeout + abort + stdin support and a uniform result
 * shape that distinguishes natural exit, timeout, and external abort.
 *
 * The kill ladder is implemented manually (not via Bun's native `signal`
 * option) so we can:
 *   1. Honour the 500ms SIGTERM → SIGKILL grace period.
 *   2. Distinguish `timedOut` from `aborted` in the returned result.
 */

export interface RunCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** How to react to a non-zero exit code, timeout, or abort. Default: `"return"`. */
  onError?: "throw" | "return";
  /** Optional stdin payload. When omitted, stdin is ignored. */
  stdin?: string;
  /**
   * Hard timeout in ms. When elapsed, the process is killed (SIGTERM, then
   * SIGKILL after a 500ms grace) and the call either rejects (when
   * `onError === "throw"`) or returns with `timedOut: true`.
   */
  timeoutMs?: number;
  /**
   * External cancellation. When fired, behaves identically to a timeout but
   * sets `aborted: true` instead. Composes with `timeoutMs` — whichever
   * fires first wins.
   */
  signal?: AbortSignal;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True if the process was killed by `timeoutMs`. */
  timedOut: boolean;
  /** True if the process was killed by an external `signal`. */
  aborted: boolean;
}

const SIGKILL_GRACE_MS = 500;

export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  const { cwd, env, onError = "return", stdin, timeoutMs, signal } = options;

  const proc = Bun.spawn({
    cmd: [command, ...args],
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]).stream(),
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let aborted = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  const killLadder = (): void => {
    if (killTimer !== undefined) return;
    try {
      proc.kill("SIGTERM");
    } catch {
      // Process may have exited between the trigger and the kill.
    }
    killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already dead — fine.
      }
    }, SIGKILL_GRACE_MS);
  };

  if (timeoutMs !== undefined) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killLadder();
    }, timeoutMs);
  }

  const onAbort = (): void => {
    aborted = true;
    killLadder();
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readStreamText(proc.stdout),
      readStreamText(proc.stderr),
      proc.exited,
    ]);

    if (onError === "throw" && (timedOut || aborted || exitCode !== 0)) {
      throw new Error(
        formatErrorMessage({
          command,
          args,
          exitCode,
          stdout,
          stderr,
          timedOut,
          aborted,
          timeoutMs,
        }),
      );
    }

    return { stdout, stderr, exitCode, timedOut, aborted };
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (killTimer !== undefined) clearTimeout(killTimer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

interface FormatErrorInput {
  command: string;
  args: readonly string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  timeoutMs: number | undefined;
}

function formatErrorMessage(input: FormatErrorInput): string {
  if (input.timedOut) {
    return `${input.command} timed out after ${input.timeoutMs}ms`;
  }
  if (input.aborted) {
    return `${input.command} aborted`;
  }
  const detail = input.stderr.trim() || input.stdout.trim();
  return `${input.command} ${input.args.join(" ")} failed with exit ${input.exitCode}: ${detail}`;
}

async function readStreamText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return new Response(stream).text();
}
