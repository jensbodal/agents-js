/**
 * `agents-js send` — one-shot prompt-response against a running `agents-js
 * serve`. The non-TUI sibling of the interactive `client` command.
 *
 * Contract:
 *
 *   agents-js send [--url <base-url> | --harness <id>] [--raw] <message>
 *
 * Routing precedence (highest first):
 *   1. `--url <base-url>` — explicit override.
 *   2. `--harness <id>` — registry lookup; first record whose `harness`
 *      matches and which has a `url` is used. Registry path comes from
 *      `AGENTS_JS_REGISTRY` or `~/.agents-js/registry.json`. A miss is a
 *      hard error (exit 1) — the user asked for a specific harness and
 *      we will not silently fall back to the env-default URL.
 *   3. `AGENTS_JS_SERVE_URL` — fallback when neither flag is provided.
 *
 * `--harness` is also threaded as `metadata.harness` on the outbound
 * message regardless of how the URL was resolved, so a multiplexing
 * gateway can still differentiate harnesses inside a single serve.
 *
 * `--raw` streams `message.delta` chunks to stdout as they arrive;
 * otherwise the command prints the final agent response once on
 * completion.
 *
 * Exit codes:
 *   0  — response completed cleanly
 *   1  — generic failure (network, transport, agent-side error, or
 *        `--harness` with no matching registry entry)
 *   71 — agent requested elicitation or auth (not supported in send
 *        mode; user must switch to `agents-js client` for interactive
 *        sessions)
 *
 * `send` reuses the completion-tracking pattern from
 * {@link runOneShotMessage} but skips the TUI dependency and does not
 * load the @opentui/core module. It also adds explicit handling for the
 * `auth_required` and `input_required` (elicitation) states so a
 * headless caller gets a deterministic exit code instead of hanging.
 */

import { A2AClientController, type AgentTargetInput } from "@agents-js/a2a-client";
import {
  type AgentRegistryRecord,
  readAgentRegistryRecords,
  resolveSharedAgentRegistryPath,
} from "@agents-js/a2a-client/node";
import { type ArgSpec, parseArgv } from "./argv-parser.ts";
import { isTerminalTaskVocabulary } from "./cli-utils.ts";
import { EXIT_AUTH_REQUIRED, EXIT_ERROR, EXIT_OK } from "./exit-codes.ts";
import { CLI_VERSION, handleVersionFlag } from "./version.ts";

export interface SendCommandArgs {
  harness?: string;
  help?: boolean;
  message?: string;
  raw: boolean;
  url?: string;
}

export interface SendCommandDependencies {
  /**
   * Factory hook so tests can inject a controller wired to a stub
   * transport. Production callers let this default to
   * `new A2AClientController(...)`.
   */
  createController?: () => A2AClientController;
  env?: NodeJS.ProcessEnv;
  /**
   * Override the registry lookup used for `--harness` routing. Tests
   * inject a synchronous in-memory list; production resolves the
   * shared registry path and reads the on-disk records.
   */
  loadRegistryRecords?: () => Promise<AgentRegistryRecord[]>;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}

const setSendHelp = (a: SendCommandArgs): void => {
  a.help = true;
};

/**
 * Argv-parser spec for `agents-js send`. Exposed for the docs
 * governance generator.
 */
export const SEND_ARG_SPEC: ArgSpec<SendCommandArgs> = {
  "--help": { kind: "flag", assign: setSendHelp, description: "Show this message." },
  "-h": { kind: "flag", assign: setSendHelp, description: "Show this message." },
  "--url": {
    kind: "value",
    assign: (a, v) => {
      a.url = v;
    },
    description:
      "Target serve base URL. Overrides --harness routing. Falls back to AGENTS_JS_SERVE_URL when neither is set.",
    valueExample: "<base-url>",
  },
  "--harness": {
    kind: "value",
    assign: (a, v) => {
      a.harness = v;
    },
    description:
      "Route to the first registered agent whose harness id matches. A miss is a hard error. Always threaded as metadata.harness on the outbound message.",
    valueExample: "<id>",
  },
  "--raw": {
    kind: "flag",
    assign: (a) => {
      a.raw = true;
    },
    description: "Stream message.delta chunks to stdout as they arrive.",
  },
};

/**
 * Parse argv for `agents-js send`. Non-flag tokens accumulate into the
 * positional message; multiple positional tokens are joined with a
 * single space so `agents-js send --url X hello world` captures
 * `"hello world"` without shell quoting.
 *
 * Exposed for the top-level CLI tests and for embedders who want to
 * parse flags without running the controller.
 */
export function parseSendCommandArgs(argv: string[]): SendCommandArgs {
  const flagArgs: string[] = [];
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token.startsWith("-")) {
      flagArgs.push(token);
      const entry = SEND_ARG_SPEC[token];
      if (entry && entry.kind === "value") {
        // Pull the value token alongside the flag so the shared parser
        // sees a well-formed --flag <value> pair.
        index += 1;
        if (index < argv.length) {
          flagArgs.push(argv[index] as string);
        }
      }
      continue;
    }
    positional.push(token);
  }

  const parsed = parseArgv<SendCommandArgs>(flagArgs, SEND_ARG_SPEC, {
    subcommandName: "send",
    defaults: {
      raw: false,
    },
  });

  if (positional.length > 0) {
    parsed.message = positional.join(" ");
  }

  return parsed;
}

export function printSendUsage(output: Pick<NodeJS.WriteStream, "write">): void {
  output.write(
    `${[
      `agents-js v${CLI_VERSION} — send`,
      "",
      "Send a one-shot prompt to a running `agents-js serve` and print the",
      "response to stdout. Non-interactive: use `agents-js client` for",
      "interactive sessions with elicitation or auth prompts.",
      "",
      "Usage:",
      "  agents-js send [options] <message>",
      "",
      "Options:",
      "  --url <base-url>   Target serve base URL. Overrides --harness routing.",
      "                     Falls back to AGENTS_JS_SERVE_URL when neither is set.",
      "  --harness <id>     Route to the first registered agent whose harness id",
      "                     matches. Looked up in the shared registry; a miss is",
      "                     a hard error (run `agents-js registry add` or pass --url).",
      "                     Always threaded as metadata.harness on the outbound message.",
      "  --raw              Stream message.delta chunks to stdout as they arrive.",
      "  --version, -v      Print version and exit",
      "  --help, -h         Show this message",
      "",
      "Environment:",
      "  AGENTS_JS_SERVE_URL  Default base URL when neither --url nor --harness is set.",
      "  AGENTS_JS_REGISTRY   Override the shared registry path used by --harness.",
      "",
      "Exit codes:",
      `  ${EXIT_OK}   Response completed cleanly.`,
      `  ${EXIT_ERROR}   Network, transport, or agent-side error.`,
      `  ${EXIT_AUTH_REQUIRED}  Agent requested elicitation or authentication (not supported in send mode).`,
    ].join("\n")}\n`,
  );
}

/**
 * Wait for a single agent response on `controller`, streaming deltas to
 * `stdout` when `raw` is true. Resolves with the exit code.
 */
function awaitSendResponse(
  controller: A2AClientController,
  stdout: Pick<NodeJS.WriteStream, "write">,
  stderr: Pick<NodeJS.WriteStream, "write">,
  raw: boolean,
): Promise<number> {
  return new Promise<number>((resolve) => {
    let messageCompleted = false;
    let lastRawLen = 0;

    const unsubscribe = controller.subscribe((event, state) => {
      if (state.status === "error") {
        unsubscribe();
        stderr.write(`[agents-js] ${state.lastError ?? "unknown error"}\n`);
        resolve(EXIT_ERROR);
        return;
      }

      if (state.activeElicitation) {
        unsubscribe();
        stderr.write(
          "[agents-js] Agent requested elicitation — send mode does not support interactive elicitation. Use 'agents-js client' for interactive sessions.\n",
        );
        resolve(EXIT_AUTH_REQUIRED);
        return;
      }

      if (state.activeAuth) {
        unsubscribe();
        stderr.write(
          "[agents-js] Agent requested authentication — send mode does not support interactive auth. Use 'agents-js client' for interactive sessions.\n",
        );
        resolve(EXIT_AUTH_REQUIRED);
        return;
      }

      if (raw && event.type === "message.delta") {
        // Prefer the incremental `delta` field when the emitter
        // populates it; otherwise compute the suffix from the
        // accumulated text so streaming consumers always see monotonic
        // forward progress.
        if (typeof event.delta === "string") {
          stdout.write(event.delta);
        } else {
          const accumulated = event.text ?? "";
          if (accumulated.length > lastRawLen) {
            stdout.write(accumulated.slice(lastRawLen));
            lastRawLen = accumulated.length;
          }
        }
      }

      if (event.type === "message.completed") {
        messageCompleted = true;
      }

      if (!isTerminalTaskVocabulary(state.taskState)) {
        return;
      }

      const lastAgent = state.transcript.findLast((entry) => entry.role === "agent");
      // Same guard as runOneShotMessage: wait for message.completed OR a
      // populated transcript before resolving, so a fast/cached task
      // update doesn't beat the transcript entry to a terminal state.
      if (!messageCompleted && !lastAgent) {
        return;
      }

      unsubscribe();
      if (raw) {
        // Streaming already drained the text; terminate with a newline
        // so the shell prompt lands on its own line.
        stdout.write("\n");
      } else if (lastAgent) {
        stdout.write(`${lastAgent.text}\n`);
      }
      resolve(state.taskState === "completed" ? EXIT_OK : EXIT_ERROR);
    });
  });
}

/**
 * Run the `send` subcommand. The function is async for symmetry with
 * the other runX commands; errors on connect / sendTurn are caught and
 * mapped to exit code 1 with a stderr diagnostic.
 */
export async function runSendCommand(
  argv: string[],
  dependencies: SendCommandDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  // biome-ignore lint/style/noProcessEnv: CLI reads the documented env var for default URL.
  const env = dependencies.env ?? process.env;

  const versionExit = handleVersionFlag(argv, stdout);
  if (versionExit !== undefined) return versionExit;

  let parsed: SendCommandArgs;
  try {
    parsed = parseSendCommandArgs(argv);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_ERROR;
  }

  if (parsed.help) {
    printSendUsage(stdout);
    return EXIT_OK;
  }

  if (!parsed.message || parsed.message.trim() === "") {
    stderr.write("[agents-js] Missing message. Usage: agents-js send --url <base-url> <message>\n");
    return EXIT_ERROR;
  }

  // Routing precedence: explicit --url > --harness registry lookup >
  // AGENTS_JS_SERVE_URL fallback. --harness with no match is fatal — we
  // do NOT silently fall back to the env URL, because that would defeat
  // the point of asking for a specific harness.
  const explicitUrl = parsed.url?.trim();
  const harnessId = parsed.harness?.trim();
  let url: string | undefined = explicitUrl;
  if (!url && harnessId) {
    const loadRecords =
      dependencies.loadRegistryRecords ??
      (() => readAgentRegistryRecords({ configPath: resolveSharedAgentRegistryPath({ env }) }));
    let records: AgentRegistryRecord[];
    try {
      records = await loadRecords();
    } catch (error) {
      stderr.write(
        `[agents-js] Failed to read agent registry: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
    const match = records.find(
      (record) =>
        record.harness === harnessId && typeof record.url === "string" && record.url.length > 0,
    );
    if (!match) {
      stderr.write(
        `[agents-js] No registered agent with harness="${harnessId}". Use \`agents-js registry add\` to register one, or pass --url <base-url>.\n`,
      );
      return 1;
    }
    url = match.url;
  }
  if (!url) {
    url = env.AGENTS_JS_SERVE_URL?.trim();
  }
  if (!url) {
    stderr.write(
      "[agents-js] Missing --url and AGENTS_JS_SERVE_URL is unset. Provide --url <base-url> or --harness <id>.\n",
    );
    return EXIT_ERROR;
  }

  const target: AgentTargetInput = {
    url,
    mode: "base",
  };

  const controller = dependencies.createController?.() ?? new A2AClientController();

  try {
    try {
      await controller.connect(target);
    } catch (error) {
      stderr.write(
        `[agents-js] Failed to connect to ${url}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return EXIT_ERROR;
    }

    const done = awaitSendResponse(controller, stdout, stderr, parsed.raw);

    try {
      // `--harness` is threaded as message metadata for future
      // gateway-side routing; current serves ignore unknown metadata.
      await controller.sendTurn(parsed.message, {
        poll: true,
        metadata: parsed.harness ? { harness: parsed.harness } : undefined,
      });
    } catch (error) {
      stderr.write(
        `[agents-js] Failed to send message: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return EXIT_ERROR;
    }

    return await done;
  } finally {
    controller.clearTargetInput();
  }
}
