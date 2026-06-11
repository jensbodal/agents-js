/**
 * `agents-js run-logged` — a thin Bun-native wrapper that runs a child
 * process while tee-ing its stderr to a logfile WITHOUT disturbing the
 * child's interactive TTY.
 *
 * Motivation: the launch orchestration starts an interactive pi TUI in a
 * tmux window. We want a durable on-disk record of the harness's stderr
 * diagnostics (stack traces, A2A bind errors, runtime warnings) without
 * losing the live view in the window. Wrapping the child so that
 * stdin/stdout stay `inherit`-ed (the TUI owns the real terminal and must
 * keep its TTY) while stderr is `pipe`-d lets us fan the stderr stream out
 * to BOTH the real `process.stderr` (so the window still shows it) and an
 * append-mode logfile.
 *
 * Contract:
 *
 *   agents-js run-logged --log <path> -- <command> [args...]
 *
 * Everything after the `--` separator is the child command + its args.
 * The `--log <path>` flag (required) names the logfile; its parent
 * directory is created if missing and the file is opened in APPEND mode so
 * repeated launches accumulate rather than truncate.
 *
 * Exit codes:
 *   0   — child exited 0 (or whatever the child's own exit code was)
 *   <n> — the child's non-zero exit code is forwarded verbatim
 *   64  — usage error (missing --log, missing command after --, unknown flag)
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { EXIT_OK, EXIT_USAGE } from "./exit-codes.ts";
import { CLI_VERSION, handleVersionFlag } from "./version.ts";

/**
 * Minimal description of a spawned child the wrapper consumes. Mirrors the
 * subset of `Bun.spawn`'s return value we rely on, so tests can inject a
 * fake without constructing a real subprocess.
 */
export interface RunLoggedChild {
  /** Piped stderr as a readable byte stream (`stderr: "pipe"`). */
  stderr: ReadableStream<Uint8Array>;
  /** Resolves with the child's numeric exit code. */
  exited: Promise<number>;
}

/** Signature of the spawn hook. Defaults to a `Bun.spawn` wrapper. */
export type RunLoggedSpawn = (command: string[]) => RunLoggedChild;

export interface RunLoggedDependencies {
  /**
   * Spawn hook. Production spawns the child with `Bun.spawn` (stdin +
   * stdout inherited, stderr piped). Tests inject a fake that returns a
   * synthetic stderr stream + a resolved `exited` code.
   */
  spawn?: RunLoggedSpawn;
  /**
   * Passthrough sink for the child's stderr — defaults to the real
   * `process.stderr`. Tests capture the bytes here to assert the tee.
   */
  stderr?: Pick<NodeJS.WriteStream, "write">;
  /** Usage/diagnostic sink — defaults to the real `process.stderr`. */
  diagnostics?: Pick<NodeJS.WriteStream, "write">;
  /**
   * Append bytes to the logfile. Defaults to `fs.appendFile`, which is
   * durable and never truncates an existing log. Tests can capture writes.
   */
  appendLog?: (logPath: string, bytes: Uint8Array) => Promise<void>;
  /**
   * Ensure the logfile's parent directory exists. Defaults to a recursive
   * `fs.mkdir`. Tests usually let this run against a real tmp dir.
   */
  ensureDir?: (dir: string) => Promise<void>;
  /** Clock hook for the header marker. Defaults to `new Date()`. */
  now?: () => Date;
}

export interface RunLoggedArgs {
  help?: boolean;
  log?: string;
  command: string[];
}

/**
 * Parse `agents-js run-logged` argv. The shared table parser does not
 * understand the `--` end-of-options marker, so we split manually: flags
 * (`--log`, `--help`) before `--`, and the child command + args after it.
 */
export function parseRunLoggedArgs(argv: string[]): RunLoggedArgs {
  const parsed: RunLoggedArgs = { command: [] };

  const separatorIndex = argv.indexOf("--");
  const flagTokens = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  if (separatorIndex !== -1) {
    parsed.command = argv.slice(separatorIndex + 1);
  }

  for (let index = 0; index < flagTokens.length; index += 1) {
    const token = flagTokens[index] as string;
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (token === "--log") {
      index += 1;
      if (index >= flagTokens.length) {
        throw new Error("[agents-js] run-logged: --log requires a value.");
      }
      parsed.log = flagTokens[index] as string;
      continue;
    }
    throw new Error(`[agents-js] Unknown run-logged argument: ${token}`);
  }

  return parsed;
}

export function printRunLoggedUsage(output: Pick<NodeJS.WriteStream, "write">): void {
  output.write(
    `${[
      `agents-js v${CLI_VERSION} — run-logged`,
      "",
      "Run a child process while tee-ing its stderr to a logfile, without",
      "disturbing the child's interactive TTY. stdin and stdout are inherited",
      "(the child owns the real terminal); stderr is fanned out to both the",
      "current window and an append-mode logfile.",
      "",
      "Usage:",
      "  agents-js run-logged --log <path> -- <command> [args...]",
      "",
      "Options:",
      "  --log <path>       Logfile path. Parent dir is created; opened append.",
      "  --version, -v      Print version and exit",
      "  --help, -h         Show this message",
      "",
      "Everything after `--` is the child command and its arguments.",
      "",
      "Example:",
      "  agents-js run-logged --log ~/.agents-js/logs/pi.log -- pi --tui",
      "",
      "Exit codes:",
      `  ${EXIT_OK}   Child exited cleanly (the child's own exit code is forwarded).`,
      `  ${EXIT_USAGE}  Usage error (missing --log, missing command after --, unknown flag).`,
    ].join("\n")}\n`,
  );
}

/**
 * Default spawn hook: `Bun.spawn` with stdin/stdout inherited (TTY stays
 * with the child) and stderr piped so we can tee it.
 */
const defaultSpawn: RunLoggedSpawn = (command) => {
  const proc = Bun.spawn(command, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "pipe",
  });
  return {
    stderr: proc.stderr as ReadableStream<Uint8Array>,
    exited: proc.exited,
  };
};

/**
 * Run the `run-logged` subcommand. Returns the child's exit code, or a
 * usage code on an argv mistake.
 */
export async function runRunLoggedCommand(
  argv: string[],
  dependencies: RunLoggedDependencies = {},
): Promise<number> {
  const diagnostics = dependencies.diagnostics ?? process.stderr;
  const stderrSink = dependencies.stderr ?? process.stderr;

  const versionExit = handleVersionFlag(argv, process.stdout);
  if (versionExit !== undefined) return versionExit;

  let args: RunLoggedArgs;
  try {
    args = parseRunLoggedArgs(argv);
  } catch (error) {
    diagnostics.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_USAGE;
  }

  if (args.help) {
    printRunLoggedUsage(process.stdout);
    return EXIT_OK;
  }

  const logPath = args.log?.trim();
  if (!logPath) {
    diagnostics.write(
      "[agents-js] run-logged: missing --log <path>. Run `agents-js run-logged --help`.\n",
    );
    return EXIT_USAGE;
  }
  if (args.command.length === 0) {
    diagnostics.write(
      "[agents-js] run-logged: missing command after `--`. Run `agents-js run-logged --help`.\n",
    );
    return EXIT_USAGE;
  }

  const spawn = dependencies.spawn ?? defaultSpawn;
  const ensureDir =
    dependencies.ensureDir ?? ((dir: string) => mkdir(dir, { recursive: true }).then(() => {}));
  const appendLog =
    dependencies.appendLog ?? ((target: string, bytes: Uint8Array) => appendFile(target, bytes));
  const now = dependencies.now ?? (() => new Date());

  await ensureDir(path.dirname(logPath));

  // Minimal header marker so successive appends are visually separable.
  // This is real CLI runtime code (not a workflow script), so a wall-clock
  // read is appropriate here.
  const header = `\n=== run-logged ${now().toISOString()} :: ${args.command.join(" ")} ===\n`;
  await appendLog(logPath, new TextEncoder().encode(header));

  const child = spawn(args.command);

  // Tee the child's stderr: each chunk goes to the live passthrough sink
  // AND the append-mode logfile. Writes are serialized within the loop so
  // the on-disk order matches the live order.
  for await (const chunk of child.stderr) {
    stderrSink.write(chunk);
    await appendLog(logPath, chunk);
  }

  const code = await child.exited;
  return typeof code === "number" ? code : EXIT_OK;
}
