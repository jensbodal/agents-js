import { tmpdir } from "node:os";
import path from "node:path";
import { type CommandResult, runCommand } from "./process-utils.ts";

export type PlaywrightCliConfig = {
  browser: {
    browserName: "chromium";
    isolated: true;
    launchOptions: {
      channel: "chromium";
      headless: boolean;
    };
  };
  outputDir: string;
  outputMode: "file";
};

const basePlaywrightCli = ["npx", "--yes", "--package", "@playwright/cli", "playwright-cli"];
export const PLAYWRIGHT_SESSION_BOOTSTRAP_TIMEOUT_MS = 30_000;
export const PLAYWRIGHT_SESSION_BOOTSTRAP_MAX_ATTEMPTS = 2;
export const PLAYWRIGHT_SESSION_READY_TIMEOUT_MS = 20_000;
export const PLAYWRIGHT_SESSION_READY_POLL_INTERVAL_MS = 250;
export const PLAYWRIGHT_SESSION_READY_SUCCESS_COUNT = 2;
export const PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_MS = 600_000;
export const DEFAULT_PLAYWRIGHT_CLI_CACHE_ROOT = path.join(tmpdir(), "agents-js-playwright-cli");
export const DEFAULT_PLAYWRIGHT_BROWSER_CACHE_ROOT = path.join(
  tmpdir(),
  "agents-js-playwright-browsers",
);

export function buildPlaywrightCliConfig(options: {
  headed: boolean;
  outputDir: string;
}): PlaywrightCliConfig {
  return {
    browser: {
      browserName: "chromium",
      isolated: true,
      launchOptions: {
        channel: "chromium",
        headless: !options.headed,
      },
    },
    outputDir: options.outputDir,
    outputMode: "file",
  };
}

export function createPlaywrightCliEnv(
  cacheDir: string,
  configPath: string,
  options: {
    browserCacheRoot?: string;
  } = {},
): Record<string, string> {
  const browserCacheBase = options.browserCacheRoot ?? DEFAULT_PLAYWRIGHT_BROWSER_CACHE_ROOT;

  return {
    npm_config_cache: cacheDir,
    PLAYWRIGHT_BROWSERS_PATH: path.join(browserCacheBase, "ms-playwright-browsers"),
    PLAYWRIGHT_DAEMON_SESSION_DIR: path.join(cacheDir, "ms-playwright-daemon"),
    PLAYWRIGHT_MCP_CONFIG: configPath,
  };
}

export async function runPlaywright(
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    allowFailure?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<CommandResult> {
  return runCommand([...basePlaywrightCli, ...args], options);
}

export function buildPlaywrightSessionBootstrapArgv(sessionName: string): string[] {
  return [`-s=${sessionName}`, "open", "about:blank"];
}

export function buildPlaywrightSessionReadyArgv(sessionName: string): string[] {
  return [`-s=${sessionName}`, "run-code", "async (page) => page.url()"];
}

export function shouldRetryPlaywrightSessionBootstrap(
  result: Pick<CommandResult, "code" | "timedOut">,
): boolean {
  return result.timedOut || result.code !== 0;
}

export function shouldRetryPlaywrightSessionReady(
  result: Pick<CommandResult, "code" | "stdout" | "stderr" | "timedOut">,
): boolean {
  if (result.timedOut) {
    return true;
  }

  if (result.code === 0) {
    return false;
  }

  const detail = `${result.stdout}\n${result.stderr}`;
  return detail.includes("is not open, please run open first");
}

export async function runPlaywrightJson<T>(
  sessionName: string,
  code: string,
  options: {
    env?: Record<string, string>;
    timeoutMs?: number;
  } = {},
  errorPrefix = "[playwright-cli]",
): Promise<T> {
  const result = await runPlaywright([`-s=${sessionName}`, "run-code", code], options);
  const lines = result.stdout.split(/\r?\n/);
  const resultIndex = lines.findIndex((line) => line.trim() === "### Result");
  const jsonLine = resultIndex >= 0 ? lines[resultIndex + 1]?.trim() : "";
  if (!jsonLine) {
    throw new Error(`${errorPrefix} Missing Playwright result payload.\n${result.stdout.trim()}`);
  }
  return JSON.parse(jsonLine) as T;
}

export async function cleanupPlaywrightSession(
  sessionName: string,
  env?: Record<string, string>,
): Promise<void> {
  await runPlaywright([`-s=${sessionName}`, "close"], {
    allowFailure: true,
    env,
    timeoutMs: 5_000,
  });
}

type OpenPlaywrightSessionDependencies = {
  cleanup: typeof cleanupPlaywrightSession;
  run: typeof runPlaywright;
  sleep?: (ms: number) => Promise<void>;
};

async function waitForPlaywrightSessionReadyWithDeps(
  sessionName: string,
  deps: OpenPlaywrightSessionDependencies,
  options: {
    cwd?: string;
    env?: Record<string, string>;
  } = {},
): Promise<CommandResult> {
  const argv = buildPlaywrightSessionReadyArgv(sessionName);
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + PLAYWRIGHT_SESSION_READY_TIMEOUT_MS;
  let consecutiveReady = 0;

  let lastResult: CommandResult = {
    code: -1,
    stderr: "",
    stdout: "",
    timedOut: false,
  };

  while (Date.now() <= deadline) {
    lastResult = await deps.run(argv, {
      allowFailure: true,
      cwd: options.cwd,
      env: options.env,
      timeoutMs: PLAYWRIGHT_SESSION_READY_TIMEOUT_MS,
    });

    if (!shouldRetryPlaywrightSessionReady(lastResult)) {
      consecutiveReady += 1;
      if (consecutiveReady >= PLAYWRIGHT_SESSION_READY_SUCCESS_COUNT) {
        return lastResult;
      }
      await sleep(PLAYWRIGHT_SESSION_READY_POLL_INTERVAL_MS);
      continue;
    }

    consecutiveReady = 0;
    await sleep(PLAYWRIGHT_SESSION_READY_POLL_INTERVAL_MS);
  }

  return lastResult;
}

export async function openPlaywrightSessionWithDeps(
  sessionName: string,
  deps: OpenPlaywrightSessionDependencies,
  options: {
    cwd?: string;
    env?: Record<string, string>;
  } = {},
): Promise<void> {
  const bootstrapArgv = buildPlaywrightSessionBootstrapArgv(sessionName);
  await deps.cleanup(sessionName, options.env);

  let lastResult: CommandResult | null = null;
  for (let attempt = 0; attempt < PLAYWRIGHT_SESSION_BOOTSTRAP_MAX_ATTEMPTS; attempt += 1) {
    lastResult = await deps.run(bootstrapArgv, {
      allowFailure: true,
      cwd: options.cwd,
      env: options.env,
      timeoutMs: PLAYWRIGHT_SESSION_BOOTSTRAP_TIMEOUT_MS,
    });

    if (!shouldRetryPlaywrightSessionBootstrap(lastResult)) {
      lastResult = await waitForPlaywrightSessionReadyWithDeps(sessionName, deps, options);
      if (!shouldRetryPlaywrightSessionReady(lastResult)) {
        return;
      }
    }

    if (attempt < PLAYWRIGHT_SESSION_BOOTSTRAP_MAX_ATTEMPTS - 1) {
      await deps.cleanup(sessionName, options.env);
    }
  }

  const detail = [lastResult?.stdout.trim(), lastResult?.stderr.trim()].filter(Boolean).join("\n");
  const timeoutDetail =
    lastResult && shouldRetryPlaywrightSessionReady(lastResult)
      ? `[playwright-cli] Playwright session did not become ready after open: ${sessionName}`
      : lastResult?.timedOut
        ? `[playwright-cli] Playwright session bootstrap timed out after ${PLAYWRIGHT_SESSION_BOOTSTRAP_TIMEOUT_MS}ms: ${sessionName}`
        : `[playwright-cli] Playwright session bootstrap failed (${lastResult?.code ?? "unknown"}): ${sessionName}`;
  throw new Error([timeoutDetail, detail].filter(Boolean).join("\n"));
}

export async function openPlaywrightSession(
  sessionName: string,
  options: {
    cwd?: string;
    env?: Record<string, string>;
  } = {},
): Promise<void> {
  await openPlaywrightSessionWithDeps(
    sessionName,
    {
      cleanup: cleanupPlaywrightSession,
      run: runPlaywright,
    },
    options,
  );
}

export async function ensureNpxAvailable(
  errorMessage: string,
  env?: Record<string, string>,
): Promise<void> {
  const result = await runCommand(["npx", "--version"], { allowFailure: true, env });
  if (result.code !== 0) {
    throw new Error(errorMessage);
  }
}

export async function ensurePlaywrightBrowser(
  browser: PlaywrightCliConfig["browser"]["browserName"],
  env?: Record<string, string>,
): Promise<void> {
  await runPlaywright(["install-browser", browser], {
    env,
    timeoutMs: PLAYWRIGHT_BROWSER_INSTALL_TIMEOUT_MS,
  });
}
