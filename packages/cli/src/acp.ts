import { type ChildProcess, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { buildForbiddenEnvKeys } from "@agents-js/acp-host";
import {
  createRuntimeSelectionFromArgs,
  listGatewayRuntimeIds,
  loadAgentsJsConfig,
  type RuntimeCommandResolver,
  type RuntimeEnvOverrides,
  resolveAndApplyGatewayRuntime,
} from "@agents-js/gateway-runtime";
import { type ArgSpec, parseArgv } from "./argv-parser.ts";
import { formatContaminationError, inspectFirstChunk } from "./contamination.ts";
import { EXIT_ERROR, EXIT_OK, EXIT_PROTOCOL_CONTAMINATION } from "./exit-codes.ts";
import { getCliRuntimeResolutionOptions } from "./runtime-resolution.ts";
import { runtimeLogArgs, runtimeSelectArgs } from "./shared-arg-specs.ts";
import { CLI_VERSION, handleVersionFlag } from "./version.ts";

/**
 * Exit code reserved for stdout contamination detected on the ACP stream.
 * Distinct from generic exit 1 (misconfiguration) and from child exit-code
 * propagation so operators can distinguish "protocol-level failure before
 * the first ndJSON byte" from other errors.
 */
export const ACP_CONTAMINATION_EXIT_CODE = EXIT_PROTOCOL_CONTAMINATION;

export interface AcpCommandArgs {
  acpArgsJson?: string;
  acpCommand?: string;
  defaultModel?: string;
  directory?: string;
  harness?: string;
  help?: boolean;
  opencodeDisableExternalPlugins?: boolean;
  profile?: string;
  runtimeLogLevel?: string;
}

export interface AcpChildProcess {
  stdin: Writable;
  stdout: Readable;
  exitPromise: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

export interface AcpCommandDependencies {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Diagnostics — defaults to `process.stderr`. */
  output?: Pick<NodeJS.WriteStream, "write">;
  /** `--help` / `--version` banner — defaults to `process.stdout`. */
  helpOutput?: Pick<NodeJS.WriteStream, "write">;
  runtimeResolver?: RuntimeCommandResolver;
  spawnProcess?: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv },
  ) => AcpChildProcess;
}

const setAcpHelp = (a: AcpCommandArgs): void => {
  a.help = true;
};

/**
 * Argv-parser spec for `agents-js acp`. Exposed as a top-level binding so
 * the docs governance generator (`scripts/docs-reference.ts`) can extract
 * the subcommand's flag table by walking the spread fragments.
 */
export const ACP_ARG_SPEC: ArgSpec<AcpCommandArgs> = {
  "--help": { kind: "flag", assign: setAcpHelp, description: "Show this message." },
  "-h": { kind: "flag", assign: setAcpHelp, description: "Show this message." },
  ...runtimeSelectArgs<AcpCommandArgs>(),
  "--directory": {
    kind: "value",
    assign: (a, v) => {
      a.directory = v;
    },
    description: "Constrain runtime to this workspace directory.",
    valueExample: "<path>",
  },
  ...runtimeLogArgs<AcpCommandArgs>(),
};

export function parseAcpCommandArgs(argv: string[]): AcpCommandArgs {
  return parseArgv<AcpCommandArgs>(argv, ACP_ARG_SPEC, { subcommandName: "acp" });
}

export function acpArgsToRuntimeEnvOverrides(args: AcpCommandArgs): RuntimeEnvOverrides {
  return {
    disableExternalPlugins: args.opencodeDisableExternalPlugins,
    runtimeLogLevel: args.runtimeLogLevel,
    defaultModel: args.defaultModel,
  };
}

function printAcpUsage(output: Pick<NodeJS.WriteStream, "write">): void {
  output.write(
    `${[
      `agents-js v${CLI_VERSION} — acp`,
      "",
      "Proxy stdio to an ACP runtime. Spawns the configured ACP runtime and pipes",
      "raw bytes between this process's stdin/stdout and the child's stdin/stdout.",
      "",
      "Usage:",
      "  agents-js acp [options]",
      "",
      "Options:",
      `  --harness <${listGatewayRuntimeIds().join("|")}|custom>  Select a curated harness or enter custom mode`,
      "  --acp-command <command>             Custom ACP command (requires --harness custom or no --harness; mutually exclusive with curated harnesses)",
      "  --acp-args-json <json>              JSON array of custom ACP args (only valid with --acp-command)",
      "  --directory <path>                  Constrain runtime to this workspace directory",
      "  --profile <name>                    Optional named profile for curated runtimes (not supported with --harness custom)",
      "  --runtime-log-level <level>         Runtime log level (debug|info|warn|error|silent)",
      "  --opencode-disable-external-plugins Append --pure when launching opencode",
      "  --default-model <id>                Default model id (AJS_DEFAULT_MODEL override)",
      "  --version, -v                       Print version and exit",
      "  --help, -h                          Show this message",
      "",
      "Config:",
      "  Reads serve.harness from the agents-js config (same key as `agents-js serve`).",
      "  User defaults:    ~/.config/agents-js/config.json",
      "  Project override: .agents-js/config.json",
      "",
      "Notes:",
      "  - stdout is reserved for ACP protocol bytes; diagnostics go to stderr.",
      "  - Defaults to the claude harness when no flags or config are provided.",
      "  - Never prompts interactively.",
      "  - The first stdout chunk from the runtime is validated as ndJSON with a",
      `    'jsonrpc' field. On contamination the cli fails fast (exit ${ACP_CONTAMINATION_EXIT_CODE}) with a`,
      "    diagnostic to stderr instead of silently hanging.",
    ].join("\n")}\n`,
  );
}

function defaultSpawnProcess(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
): AcpChildProcess {
  // `detached: true` makes the spawned process a process-group leader on Unix,
  // which lets `kill()` below signal the whole group (child + grandchildren).
  // Without this, grandchildren (e.g. shells spawned by the runtime) get
  // reparented to init when the direct child exits and continue running —
  // silently draining API tokens. Mirrors createHostACPProcess.
  //
  // `unref()` is intentionally NOT called: this CLI command owns the child's
  // lifetime and forwards signals to it via the returned `kill()` function.
  //
  // On Windows, `detached: true` opens a new console window, so we gate this
  // off platform.
  const isUnix = process.platform !== "win32";
  const child: ChildProcess = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: options.env,
    detached: isUnix,
  });

  if (!child.stdin || !child.stdout) {
    throw new Error("[agents-js acp] Failed to get stdin/stdout from spawned process.");
  }

  const exitPromise = new Promise<number>((resolve, reject) => {
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
    child.on("error", (err) => {
      reject(err);
    });
  });

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    exitPromise,
    kill(signal?: NodeJS.Signals) {
      // On Unix, signal the whole process group (pgid === child.pid because
      // of `detached: true`) so grandchildren are cleaned up too.
      if (isUnix && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal ?? "SIGTERM");
        } catch {
          /* process-group already dead */
        }
        return;
      }
      child.kill(signal);
    },
  };
}

export async function runAcpCommand(
  argv: string[],
  dependencies: AcpCommandDependencies = {},
): Promise<number> {
  // Diagnostics route to stderr; help/version routes to stdout so the
  // ACP protocol stream (which lives on stdout in steady state) stays
  // unmixed with diagnostic text.
  const output = dependencies.output ?? process.stderr;
  const helpOutput = dependencies.helpOutput ?? process.stdout;

  const versionExit = handleVersionFlag(argv, helpOutput);
  if (versionExit !== undefined) return versionExit;

  const args = parseAcpCommandArgs(argv);

  if (args.help) {
    printAcpUsage(helpOutput);
    return EXIT_OK;
  }

  const loadedConfig = await loadAgentsJsConfig({
    cwd: dependencies.cwd,
    env: dependencies.env,
  });
  const effectiveConfig = loadedConfig.effectiveConfig;

  const argSelection = createRuntimeSelectionFromArgs(args);
  const runtimeSelection = argSelection ?? effectiveConfig.serve?.harness;
  if (!runtimeSelection) {
    output.write("[agents-js acp] No runtime configured.\n");
    return EXIT_ERROR;
  }

  // Apply CLI-flag overrides to the live env so downstream helpers
  // (resolveRuntimeArgs, plus the spawned child's env assembled below) and
  // the spawned-child env we copy from `process.env` observe them.
  // Precedence: CLI flag > pre-existing env > default. The shared helper
  // resolves the runtime, optionally applies a configured profile, and
  // restores the env (even on error). See resolve-and-apply.ts for the
  // latent design-tension docblock around env mutation.
  const runtime = await resolveAndApplyGatewayRuntime({
    selection: runtimeSelection,
    envOverrides: acpArgsToRuntimeEnvOverrides(args),
    resolver: dependencies.runtimeResolver,
    runtimeResolution: getCliRuntimeResolutionOptions(),
    profileLookup: {
      configPaths: loadedConfig.paths,
      projectConfig: loadedConfig.projectConfig,
      userConfig: loadedConfig.userConfig,
    },
    // acp tolerates a missing configured profile (silently skips the
    // profile-application step). Serve treats it as an invariant violation
    // because its setup phase guarantees the profile exists.
    onMissingProfile: "skip",
  });

  const spawnFn = dependencies.spawnProcess ?? defaultSpawnProcess;
  const command = runtime.acp.command;
  if (!command) {
    output.write("[agents-js acp] Resolved runtime has no command. This is likely a bug.\n");
    return EXIT_ERROR;
  }
  const configBinPaths = effectiveConfig.extraBinPaths ?? [];
  const home = process.env.HOME ?? "";
  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional placeholder resolved at runtime
  const resolvedBinPaths = configBinPaths.map((p) => p.replace("${HOME}", home));
  const extraPath = resolvedBinPaths.length > 0 ? `:${resolvedBinPaths.join(":")}` : "";
  // Filter security-sensitive keys from the runtime env. PATH is
  // re-constructed explicitly below, so stripping it here is harmless.
  // HOME is intentionally allowed through because operator-configured
  // profiles use it for isolation (unlike agent extraEnv in process.ts).
  // The forbidden set is derived from the resolved runtime's per-harness
  // `authEnvKeys` so the CLI's filter matches what the host applies.
  const forbiddenEnvKeys = buildForbiddenEnvKeys({
    agentSecretEnvKeys: runtime.definition.authEnvKeys,
  });
  const filteredEnv = Object.fromEntries(
    Object.entries(runtime.acp.env ?? {}).filter(([k]) => !forbiddenEnvKeys.has(k) || k === "HOME"),
  );
  const childEnv = {
    ...process.env,
    ...filteredEnv,
    PATH: `${process.env.PATH ?? ""}${extraPath}`,
  };
  const runtimeArgs = [...(runtime.acp.args ?? [])];
  if (args.directory) {
    runtimeArgs.push(runtime.acp.workspaceFlag ?? "--directory", args.directory);
  }
  const child = spawnFn(command, runtimeArgs, { env: childEnv });

  try {
    // Swallow EPIPE on child.stdin — normal when child exits before stdin is drained.
    child.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") {
        output.write(`[agents-js acp] child stdin error: ${err.message}\n`);
      }
    });
    process.stdin.pipe(child.stdin);

    // Inspect the FIRST stdout chunk for contamination before forwarding any
    // bytes to stdout. On pass, forward the chunk verbatim and resume
    // streaming via pipe(). On fail, terminate the child, log a formatted
    // diagnostic to stderr, and exit with ACP_CONTAMINATION_EXIT_CODE.
    //
    // We do NOT call child.stdout.pipe(process.stdout) before the first
    // chunk — otherwise a contaminated prefix would leak to stdout before
    // detection. Subsequent chunks flow through pipe() unchanged, matching
    // the previous behavior.
    let contamination: ReturnType<typeof inspectFirstChunk> | undefined;
    const firstChunkHandled = new Promise<void>((resolve) => {
      child.stdout.once("data", (chunk: Buffer) => {
        const result = inspectFirstChunk(chunk);
        if (!result.ok) {
          contamination = result;
          resolve();
          return;
        }
        // Forward the first chunk verbatim, then pipe the rest.
        process.stdout.write(chunk);
        child.stdout.pipe(process.stdout);
        resolve();
      });
      // If the child closes its stdout without producing any data, resolve
      // so we don't hang the shutdown path. exitPromise will still resolve
      // with the child's exit code.
      child.stdout.once("end", () => {
        resolve();
      });
    });

    const onSigterm = (): void => {
      child.kill("SIGTERM");
    };
    const onSigint = (): void => {
      child.kill("SIGINT");
    };

    process.on("SIGTERM", onSigterm);
    process.on("SIGINT", onSigint);

    try {
      // Wait for the first chunk inspection to complete (or stdout close)
      // before deciding whether to surface a contamination error. If
      // contaminated, terminate the child and fail fast; do not propagate
      // the child's exit code.
      await firstChunkHandled;
      if (contamination) {
        output.write(`${formatContaminationError(contamination)}\n`);
        child.kill("SIGTERM");
        // Drain the child so process-group cleanup completes before exit.
        // We intentionally discard the exit code — contamination is the
        // authoritative failure signal for this invocation.
        try {
          await child.exitPromise;
        } catch {
          /* ignored */
        }
        return ACP_CONTAMINATION_EXIT_CODE;
      }

      const exitCode = await child.exitPromise;
      return exitCode;
    } finally {
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGINT", onSigint);
    }
  } finally {
    process.stdin.unpipe(child.stdin);
  }
}
