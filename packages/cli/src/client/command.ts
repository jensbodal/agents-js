import {
  A2AClientController,
  type AgentTargetInput,
  type DebugRecord,
  type ProbeResult,
} from "@agents-js/a2a-client";
import { type CliRenderer, createCliRenderer, type KeyEvent } from "@opentui/core";
import { type ArgSpec, parseArgv } from "../argv-parser.ts";
import { isTerminalTaskVocabulary } from "../cli-utils.ts";
import { EXIT_ERROR, EXIT_OK } from "../exit-codes.ts";
import { CLI_VERSION, handleVersionFlag } from "../version.ts";
import { type ClientApp, createClientApp } from "./ui/app.ts";

export interface ClientCommandArgs {
  card?: string;
  contextId?: string;
  headers: Record<string, string>;
  help?: boolean;
  message?: string;
  poll: boolean;
  probe: boolean;
  raw: boolean;
  taskId?: string;
  url?: string;
}

export interface StartClientAppOptions {
  contextId?: string;
  poll: boolean;
  raw: boolean;
  target: AgentTargetInput;
  taskId?: string;
}

export interface ClientCommandDependencies {
  createRenderer?: () => Promise<CliRenderer>;
  output?: Pick<NodeJS.WriteStream, "write">;
  runApp?: (options: StartClientAppOptions) => Promise<number>;
}

function parseHeader(raw: string): [string, string] {
  const separator = raw.indexOf(":");
  if (separator <= 0) {
    throw new Error(`[agents-js] Invalid --header value "${raw}". Expected name:value.`);
  }

  const key = raw.slice(0, separator).trim();
  const value = raw.slice(separator + 1).trim();
  if (!key || !value) {
    throw new Error(`[agents-js] Invalid --header value "${raw}". Expected name:value.`);
  }

  return [key, value];
}

const setHelp = (a: ClientCommandArgs): void => {
  a.help = true;
};

const setMessage = (a: ClientCommandArgs, v: string): void => {
  a.message = v;
};

const CLIENT_ARG_SPEC: ArgSpec<ClientCommandArgs> = {
  "--help": { kind: "flag", assign: setHelp },
  "-h": { kind: "flag", assign: setHelp },
  "--url": {
    kind: "value",
    assign: (a, v) => {
      a.url = v;
    },
  },
  "--card": {
    kind: "value",
    assign: (a, v) => {
      a.card = v;
    },
  },
  // Repeatable: each occurrence appends to the headers map. Inline
  // normalization trims key/value and rejects whitespace-only values so
  // `--header " : "` and `--header "a: "` fail at parse time.
  "--header": {
    kind: "value",
    assign: (a, v) => {
      const [key, value] = parseHeader(v);
      a.headers[key] = value;
    },
  },
  "--context-id": {
    kind: "value",
    assign: (a, v) => {
      a.contextId = v;
    },
  },
  "--task-id": {
    kind: "value",
    assign: (a, v) => {
      a.taskId = v;
    },
  },
  "--raw": {
    kind: "flag",
    assign: (a) => {
      a.raw = true;
    },
  },
  "--probe": {
    kind: "flag",
    assign: (a) => {
      a.probe = true;
    },
  },
  "--no-poll": {
    kind: "flag",
    assign: (a) => {
      a.poll = false;
    },
  },
  "--message": { kind: "value", assign: setMessage },
  "-m": { kind: "value", assign: setMessage },
};

export function parseClientCommandArgs(argv: string[]): ClientCommandArgs {
  // Defaults live on the spec call so the shared parser seeds the result
  // object; `headers` is created fresh per call via the `{ ... }` spread
  // inside `parseArgv` so concurrent callers never share a map.
  return parseArgv<ClientCommandArgs>(argv, CLIENT_ARG_SPEC, {
    subcommandName: "client",
    defaults: {
      headers: {},
      poll: true,
      probe: false,
      raw: false,
    },
  });
}

export function printClientUsage(output: Pick<NodeJS.WriteStream, "write">): void {
  output.write(
    `${[
      `agents-js v${CLI_VERSION} — client`,
      "",
      "Usage:",
      "  agents-js client (--url <base-url> | --card <card-url>) [options]",
      "",
      "Options:",
      "  --url <base-url>       Connect using a base A2A URL",
      "  --card <card-url>      Connect using a full agent card URL",
      "  --header <name:value>  Repeatable custom header",
      "  --context-id <id>      Reuse an existing context id",
      "  --task-id <id>         Reuse a specific task id",
      "  --raw                  Show raw JSON in the inspector",
      "  --message, -m <text>   Send a single message and print the response (no TUI)",
      "  --probe                Probe endpoints and print the results without launching the TUI",
      "  --no-poll              Send messages without polling task state to completion",
      "  --version, -v          Print version and exit",
      "  --help, -h             Show this message",
    ].join("\n")}\n`,
  );
}

function createRenderer(): Promise<CliRenderer> {
  return createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
  });
}

function printProbeResults(
  output: Pick<NodeJS.WriteStream, "write">,
  results: ProbeResult[],
  debugRecords: DebugRecord[],
  raw: boolean,
): void {
  for (const result of results) {
    output.write(
      `${result.status.toString().padStart(3, " ")} ${result.method.padEnd(7, " ")} ${result.url}\n`,
    );
    if (raw && result.bodySnippet) {
      output.write(`${result.bodySnippet}\n`);
    }
  }

  if (raw && debugRecords.length > 0) {
    output.write("\nDebug Records:\n");
    for (const record of debugRecords) {
      output.write(`${JSON.stringify(record, null, 2)}\n`);
    }
  }
}

/**
 * Wire the Escape / Tab / Ctrl+R keypress handlers onto the shared
 * renderer, and register a single `destroy` subscriber that detaches
 * them. Exposed for testing so listener cleanup can be asserted
 * without standing up a full A2A controller + transport.
 *
 * Without the `off("keypress", ...)` call on destroy, repeated TUI
 * sessions (e.g. harness restart, agent reconnect) accumulate dead
 * listeners on the long-lived renderer.
 */
export function attachClientKeyHandlers(
  renderer: CliRenderer,
  controller: Pick<A2AClientController, "resetSession" | "reportError">,
  app: Pick<ClientApp, "destroy" | "nextInspectorTab">,
): { detach(): void } {
  const keypressHandler = (key: KeyEvent): void => {
    if (key.name === "escape") {
      app.destroy();
      renderer.destroy();
      return;
    }

    if (key.name === "tab") {
      app.nextInspectorTab();
      return;
    }

    if (key.ctrl && key.name === "r") {
      try {
        controller.resetSession();
      } catch (error) {
        // Surface the reset failure through the controller so the
        // header/inspector can display it — do not let it escape as an
        // unhandled rejection in the keypress listener.
        controller.reportError(error);
      }
    }
  };
  renderer.keyInput.on("keypress", keypressHandler);

  const detach = (): void => {
    renderer.keyInput.off("keypress", keypressHandler);
  };

  renderer.on("destroy", () => {
    // Detach first so `app.destroy()` can't re-register anything in a
    // cascade. Stops the listener from being attached to the shared
    // renderer after the app that owns it has shut down.
    detach();
    app.destroy();
  });

  return { detach };
}

export async function startClientApp(
  options: StartClientAppOptions,
  dependencies: Pick<ClientCommandDependencies, "createRenderer"> = {},
): Promise<number> {
  const controller = new A2AClientController({
    initialState: {
      contextId: options.contextId,
      taskId: options.taskId,
      resumableTaskId: options.taskId,
    },
  });
  await controller.connect(options.target);
  if (options.taskId) {
    await controller.resumeTurn(options.taskId, {
      stream: true,
    });
  }

  const renderer = await (dependencies.createRenderer ?? createRenderer)();
  const app = createClientApp(renderer, controller, {
    poll: options.poll,
    raw: options.raw,
  });

  attachClientKeyHandlers(renderer, controller, app);

  app.start();

  return new Promise<number>((resolve) => {
    renderer.on("destroy", () => resolve(EXIT_OK));
  });
}

export interface OneShotMessageDependencies {
  /**
   * Factory hook so tests can inject a controller wired to a stub
   * transport. Production callers let this default.
   */
  createController?: (options: { contextId?: string; taskId?: string }) => A2AClientController;
}

export async function runOneShotMessage(
  target: AgentTargetInput,
  parsed: ClientCommandArgs,
  output: Pick<NodeJS.WriteStream, "write">,
  dependencies: OneShotMessageDependencies = {},
): Promise<number> {
  const controller =
    dependencies.createController?.({
      contextId: parsed.contextId,
      taskId: parsed.taskId,
    }) ??
    new A2AClientController({
      initialState: {
        contextId: parsed.contextId,
        taskId: parsed.taskId,
      },
    });

  try {
    await controller.connect(target);

    const done = new Promise<number>((resolve) => {
      // Track `message.completed` explicitly so we don't exit prematurely
      // when a cached/fast response flips taskState to terminal + status
      // back to "connected" before the transcript is populated.
      let messageCompleted = false;

      const unsubscribe = controller.subscribe((event, state) => {
        if (state.status === "error") {
          unsubscribe();
          output.write(`Error: ${state.lastError ?? "unknown error"}\n`);
          resolve(EXIT_ERROR);
          return;
        }

        if (event.type === "message.completed") {
          messageCompleted = true;
        }

        if (!isTerminalTaskVocabulary(state.taskState)) {
          return;
        }

        const lastAgent = state.transcript.findLast((entry) => entry.role === "agent");
        // Hold until we either saw message.completed (the authoritative
        // "transcript is populated" signal) OR there's at least one agent
        // transcript entry. Without this guard, a task.updated event that
        // transitions to a terminal state + flips status back to
        // "connected" could resolve with no output.
        if (!messageCompleted && !lastAgent) {
          return;
        }

        unsubscribe();
        if (lastAgent) {
          output.write(`${lastAgent.text}\n`);
        }
        resolve(state.taskState === "completed" ? EXIT_OK : EXIT_ERROR);
      });
    });

    await controller.sendTurn(parsed.message ?? "", { poll: parsed.poll });

    return await done;
  } finally {
    // Release any pending inspection timers so a dangling setTimeout
    // doesn't keep the process alive after the response resolves.
    controller.clearTargetInput();
  }
}

export async function runClientCommand(
  argv: string[],
  dependencies: ClientCommandDependencies = {},
): Promise<number> {
  const output = dependencies.output ?? process.stdout;

  const versionExit = handleVersionFlag(argv, output);
  if (versionExit !== undefined) return versionExit;

  const parsed = parseClientCommandArgs(argv);

  if (parsed.help) {
    printClientUsage(output);
    return EXIT_OK;
  }

  if ((parsed.url ? 1 : 0) + (parsed.card ? 1 : 0) !== 1) {
    // EXIT_USAGE = 64 — missing/conflicting required args. Print client
    // usage to stderr so scripted callers see the help text alongside the
    // diagnostic, then exit with the standard sysexits(3) usage code.
    process.stderr.write("[agents-js] Provide exactly one of --url or --card.\n");
    printClientUsage(process.stderr);
    return 64;
  }

  const target: AgentTargetInput = {
    url: parsed.url ?? parsed.card ?? "",
    headers: parsed.headers,
    mode: parsed.card ? "card" : "base",
  };

  if (parsed.probe) {
    const controller = new A2AClientController({
      initialState: {
        contextId: parsed.contextId,
        taskId: parsed.taskId,
      },
    });
    const results = await controller.probe(target);
    printProbeResults(output, results, controller.getState().debugRecords, parsed.raw);
    return EXIT_OK;
  }

  if (parsed.message !== undefined) {
    return runOneShotMessage(target, parsed, output);
  }

  if (!dependencies.runApp && !process.stdout.isTTY) {
    process.stderr.write(
      "[agents-js] Interactive TUI requires a terminal. Use --message (-m) for non-interactive mode:\n" +
        '  agents-js client --url <url> -m "your message"\n',
    );
    return EXIT_ERROR;
  }

  return (dependencies.runApp ?? ((options) => startClientApp(options, dependencies)))({
    contextId: parsed.contextId,
    poll: parsed.poll,
    raw: parsed.raw,
    target,
    taskId: parsed.taskId,
  });
}
