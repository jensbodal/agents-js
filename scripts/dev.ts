#!/usr/bin/env bun

import {
  type GatewayRuntimeId,
  getGatewayRuntimeDefinition,
  listGatewayRuntimeIds,
} from "@agents-js/gateway-runtime";
import { parseGatewayPort } from "../apps/internal-gateway/discovery.ts";
import { gatewayConfig } from "../apps/internal-gateway/gateway.config.ts";
import {
  buildLauncherOpenUrl,
  extractGatewayUrl,
  extractGatewayWsUrl,
  extractViteLocalUrl,
} from "./browser-launch-contract.ts";
import { runForeground, spawnLogged, stopProcess, waitForGatewayCard } from "./process-utils.ts";
import { repoRoot } from "./workspace-config.ts";

type ExitResult = {
  code: number;
  label: string;
};

export interface DevArgs {
  port?: number;
  runtime: GatewayRuntimeId;
}

type DiscoveryHandlers = {
  onGatewayUrl(url: string): void;
  onGatewayWsUrl(url: string): void;
  onWebUiUrl(url: string): void;
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function handleDiscoveryLine(line: string, handlers: DiscoveryHandlers): void {
  const gatewayUrl = extractGatewayUrl(line);
  if (gatewayUrl) {
    handlers.onGatewayUrl(gatewayUrl);
  }

  const gatewayWsUrl = extractGatewayWsUrl(line);
  if (gatewayWsUrl) {
    handlers.onGatewayWsUrl(gatewayWsUrl);
  }

  const webUiUrl = extractViteLocalUrl(line);
  if (webUiUrl) {
    handlers.onWebUiUrl(webUiUrl);
  }
}

export function parseDevArgs(argv: string[]): DevArgs {
  let runtime: GatewayRuntimeId = gatewayConfig.runtime;
  let port: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--runtime") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('[dev] Missing value for "--runtime".');
      }
      runtime = getGatewayRuntimeDefinition(next).id as GatewayRuntimeId;
      index += 1;
      continue;
    }

    if (arg === "--port") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('[dev] Missing value for "--port".');
      }
      port = parseGatewayPort(next, "--port");
      index += 1;
      continue;
    }

    throw new Error(
      `[dev] Unknown argument "${arg}". Supported args: --runtime <${listGatewayRuntimeIds().join("|")}>, --port <port>.`,
    );
  }

  return { runtime, port };
}

export async function main(argv: string[] = Bun.argv.slice(2)): Promise<number> {
  const args = parseDevArgs(argv);
  let discoveredGatewayUrl: string | null = null;
  let discoveredGatewayWsUrl: string | null = null;
  let discoveredWebUiUrl: string | null = null;

  await runForeground(["bun", "scripts/doctor.ts", "--runtime", args.runtime]);

  const gatewayUrlDeferred = createDeferred<string>();
  const gatewayWsUrlDeferred = createDeferred<string>();
  const webUiUrlDeferred = createDeferred<string>();

  const gatewayArgs = [
    "vp",
    "run",
    "-w",
    "repo:dev:gateway",
    "--",
    "--runtime",
    args.runtime,
    "--workspace",
    repoRoot,
  ];
  if (args.port !== undefined) {
    gatewayArgs.push("--port", String(args.port));
  }
  const gatewayProc = spawnLogged("gateway", gatewayArgs, {
    onStderrLine(line) {
      handleDiscoveryLine(line, {
        onGatewayUrl(url) {
          if (discoveredGatewayUrl === null) {
            discoveredGatewayUrl = url;
            gatewayUrlDeferred.resolve(url);
          }
        },
        onGatewayWsUrl(url) {
          if (discoveredGatewayWsUrl === null) {
            discoveredGatewayWsUrl = url;
            gatewayWsUrlDeferred.resolve(url);
          }
        },
        onWebUiUrl() {},
      });
    },
    onStdoutLine(line) {
      handleDiscoveryLine(line, {
        onGatewayUrl(url) {
          if (discoveredGatewayUrl === null) {
            discoveredGatewayUrl = url;
            gatewayUrlDeferred.resolve(url);
          }
        },
        onGatewayWsUrl(url) {
          if (discoveredGatewayWsUrl === null) {
            discoveredGatewayWsUrl = url;
            gatewayWsUrlDeferred.resolve(url);
          }
        },
        onWebUiUrl() {},
      });
    },
  });
  let webUiProc: Bun.Subprocess<"pipe", "pipe", "inherit"> | null = null;
  let shuttingDown = false;

  const shutdown = (exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopProcess(webUiProc);
    stopProcess(gatewayProc);
    process.exit(exitCode);
  };

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  try {
    const gatewayExitError = gatewayProc.exited.then((code) => {
      throw new Error(
        [
          `[dev] Gateway exited before discovery completed (code ${code}).`,
          `Run \`bun scripts/doctor.ts --runtime ${args.runtime}\` or`,
          `\`vp run -w repo:dev:gateway -- --check --runtime ${args.runtime}\``,
          "to validate the selected runtime.",
        ].join("\n"),
      );
    });

    const [gatewayUrl, gatewayWsUrl] = await Promise.race([
      Promise.all([gatewayUrlDeferred.promise, gatewayWsUrlDeferred.promise]),
      gatewayExitError,
    ]);

    webUiProc = spawnLogged("web-ui", ["vp", "run", "-w", "repo:dev:web"], {
      env: {
        VITE_AGENTS_DEFAULT_TARGET_URL: gatewayUrl,
        VITE_AGENTS_DEFAULT_WS_URL: gatewayWsUrl,
      },
      onStderrLine(line) {
        handleDiscoveryLine(line, {
          onGatewayUrl() {},
          onGatewayWsUrl() {},
          onWebUiUrl(url) {
            if (discoveredWebUiUrl === null) {
              discoveredWebUiUrl = url;
              webUiUrlDeferred.resolve(url);
            }
          },
        });
      },
      onStdoutLine(line) {
        handleDiscoveryLine(line, {
          onGatewayUrl() {},
          onGatewayWsUrl() {},
          onWebUiUrl(url) {
            if (discoveredWebUiUrl === null) {
              discoveredWebUiUrl = url;
              webUiUrlDeferred.resolve(url);
            }
          },
        });
      },
    });

    const webUiExitError = webUiProc.exited.then((code) => {
      throw new Error(`[dev] web-ui exited before its local URL was printed (code ${code}).`);
    });

    const [_, webUiUrl] = await Promise.all([
      Promise.race([waitForGatewayCard(gatewayUrl), gatewayExitError]),
      Promise.race([webUiUrlDeferred.promise, gatewayExitError, webUiExitError]),
    ]);

    console.log(`[dev] Gateway URL: ${gatewayUrl}`);
    console.log(`[dev] Gateway WS URL: ${gatewayWsUrl}`);

    console.log(`[dev] Web UI URL: ${webUiUrl}`);
    console.log(`[dev] Open URL: ${buildLauncherOpenUrl(webUiUrl, gatewayUrl, gatewayWsUrl)}`);

    const result = await Promise.race<ExitResult>([
      gatewayProc.exited.then((code) => ({ label: "gateway", code })),
      webUiProc.exited.then((code) => ({ label: "web-ui", code })),
    ]);

    if (result.code !== 0) {
      throw new Error(`[dev] ${result.label} exited with code ${result.code}.`);
    }

    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        detail,
        "",
        `[dev] Gateway URL: ${discoveredGatewayUrl ?? "not discovered"}`,
        `[dev] Gateway WS URL: ${discoveredGatewayWsUrl ?? "not discovered"}`,
        `[dev] Web UI URL: ${discoveredWebUiUrl ?? "not discovered"}`,
        `[dev] Selected runtime: ${args.runtime}`,
        `[dev] Checked-in default runtime: ${gatewayConfig.runtime}`,
        `Use \`bun scripts/doctor.ts --runtime ${args.runtime}\` to validate runtime availability before launching again.`,
      ].join("\n"),
    );
  } finally {
    stopProcess(webUiProc);
    stopProcess(gatewayProc);
  }
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
