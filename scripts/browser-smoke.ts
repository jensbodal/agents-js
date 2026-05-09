#!/usr/bin/env bun

import { mkdir, rm as removePath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildBrowserConsoleExportCode,
  buildBrowserConsoleInitScript,
} from "./browser-console-capture.ts";
import {
  buildPlaywrightCliConfig,
  cleanupPlaywrightSession,
  createPlaywrightCliEnv,
  DEFAULT_PLAYWRIGHT_CLI_CACHE_ROOT,
  ensureNpxAvailable,
  ensurePlaywrightBrowser,
  openPlaywrightSession,
  runPlaywright,
  runPlaywrightJson,
} from "./playwright-cli.ts";
import {
  assertPortAvailable,
  buildProcessEnv,
  spawnLogged,
  stopProcess,
  waitForHttp,
} from "./process-utils.ts";

type BrowserSmokeOptions = {
  commandName: string;
  headed: boolean;
  outDir: string;
  playwrightCacheRoot?: string;
  sessionName: string;
  uiPort: number;
};

export type BrowserConsoleEntry = {
  level?: string;
  text?: string;
};

const repoRoot = path.resolve(import.meta.dir, "..");
const mockAgentPath = path.join(repoRoot, "tests/mock-acp-agent.cjs");
const defaultOutDir = path.join(repoRoot, "output/playwright/browser-smoke");
const gatewayHost = "127.0.0.1";
const defaultUiPort = 4173;
const defaultCommandName = "browser:smoke";
const playwrightStepTimeoutMs = 20_000;
const playwrightScreenshotTimeoutMs = 30_000;

function hashString(value: string): string {
  let hash = 5381;
  for (const character of value) {
    hash = ((hash << 5) + hash + character.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}

function normalizeSessionName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const fallback = normalized || "pw";

  if (fallback.length <= 12) {
    return fallback;
  }

  return `${fallback.slice(0, 5)}-${hashString(fallback).slice(0, 6)}`;
}

function buildDefaultSessionName(_commandName: string): string {
  return `bsm-${Date.now().toString(36).slice(-4)}`;
}

function printUsage(): void {
  console.log(
    [
      "browser-smoke",
      "",
      "Usage:",
      "  bun scripts/browser-smoke.ts [--headed] [--out-dir <path>] [--ui-port <port>] [--playwright-cache-root <path>] [--session-name <name>] [--command-name <name>]",
      "",
      "Runs a deterministic browser smoke flow against apps/web-ui using",
      "the mock ACP agent and local Playwright CLI.",
    ].join("\n"),
  );
}

export function buildBrowserSmokeArgv(options: {
  commandName?: string;
  headed: boolean;
  outDir: string;
  playwrightCacheRoot?: string;
  sessionName?: string;
  uiPort?: number;
}): string[] {
  const argv = ["bun", "scripts/browser-smoke.ts", "--out-dir", options.outDir];

  if (options.headed) {
    argv.push("--headed");
  }
  if (options.playwrightCacheRoot) {
    argv.push("--playwright-cache-root", options.playwrightCacheRoot);
  }
  if (options.sessionName) {
    argv.push("--session-name", options.sessionName);
  }
  if (options.commandName) {
    argv.push("--command-name", options.commandName);
  }
  if (options.uiPort !== undefined) {
    argv.push("--ui-port", String(options.uiPort));
  }

  return argv;
}

function parseArgs(argv: string[]): BrowserSmokeOptions {
  let commandName = defaultCommandName;
  let headed = false;
  let outDir = defaultOutDir;
  let playwrightCacheRoot: string | undefined;
  let sessionName: string | undefined;
  let uiPort = defaultUiPort;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case "--headed":
        headed = true;
        break;
      case "--out-dir":
        if (!next) {
          throw new Error('[browser-smoke] Missing value for "--out-dir".');
        }
        outDir = path.resolve(repoRoot, next);
        index += 1;
        break;
      case "--ui-port":
        if (!next) {
          throw new Error('[browser-smoke] Missing value for "--ui-port".');
        }
        uiPort = Number.parseInt(next, 10);
        if (!Number.isFinite(uiPort) || uiPort <= 0) {
          throw new Error(`[browser-smoke] Invalid port "${next}".`);
        }
        index += 1;
        break;
      case "--playwright-cache-root":
        if (!next) {
          throw new Error('[browser-smoke] Missing value for "--playwright-cache-root".');
        }
        playwrightCacheRoot = path.resolve(repoRoot, next);
        index += 1;
        break;
      case "--session-name":
        if (!next) {
          throw new Error('[browser-smoke] Missing value for "--session-name".');
        }
        sessionName = next;
        index += 1;
        break;
      case "--command-name":
        if (!next) {
          throw new Error('[browser-smoke] Missing value for "--command-name".');
        }
        commandName = next;
        index += 1;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`[browser-smoke] Unknown argument: ${arg}`);
    }
  }

  return {
    commandName,
    headed,
    outDir,
    playwrightCacheRoot,
    sessionName: normalizeSessionName(sessionName ?? buildDefaultSessionName(commandName)),
    uiPort,
  };
}

function toPosix(filePath: string): string {
  return filePath.replaceAll(path.sep, "/");
}

function isLitDevModeWarning(entry: BrowserConsoleEntry): boolean {
  return (
    entry.level === "warn" &&
    typeof entry.text === "string" &&
    entry.text.includes("Lit is in dev mode. Not recommended for production!")
  );
}

export function classifyBrowserConsoleEntries(entries: BrowserConsoleEntry[]): {
  expectedWarnings: BrowserConsoleEntry[];
  unexpectedWarnings: BrowserConsoleEntry[];
  unexpectedErrors: BrowserConsoleEntry[];
} {
  return entries.reduce(
    (acc, entry) => {
      if (isLitDevModeWarning(entry)) {
        acc.expectedWarnings.push(entry);
      } else if (entry.level === "warn") {
        acc.unexpectedWarnings.push(entry);
      } else if (entry.level === "error") {
        acc.unexpectedErrors.push(entry);
      }
      return acc;
    },
    {
      expectedWarnings: [] as BrowserConsoleEntry[],
      unexpectedWarnings: [] as BrowserConsoleEntry[],
      unexpectedErrors: [] as BrowserConsoleEntry[],
    },
  );
}

function buildInitialCode(params: { webUiUrl: string; gatewayUrl: string }): string {
  return `
async (page) => {
  const webUiUrl = ${JSON.stringify(params.webUiUrl)};
  const expectedGatewayUrl = ${JSON.stringify(params.gatewayUrl)};
  const timeoutMs = 10_000;

  const requireVisible = async (locator, label) => {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    return locator;
  };

  await page.addInitScript(${buildBrowserConsoleInitScript()});

  await page.goto(webUiUrl, { waitUntil: "domcontentloaded" });

  const connectDialog = page.locator("acp-connect-dialog");
  await requireVisible(connectDialog, "connect dialog");
  const connectInput = connectDialog.locator(".url-row input[type=\\"text\\"]");
  await requireVisible(connectInput, "connect dialog input");
  const connectButton = connectDialog.getByRole("button", { name: "Connect" });
  await requireVisible(connectButton, "connect dialog button");

  const actualGatewayUrl = await connectInput.inputValue();
  if (actualGatewayUrl !== expectedGatewayUrl) {
    throw new Error(
      "[browser-smoke] Expected default connect URL " +
        expectedGatewayUrl +
        ", received " +
        actualGatewayUrl,
    );
  }

  const initialDisabled = await connectButton.isDisabled();
  if (!initialDisabled) {
    throw new Error(
      "[browser-smoke] Connect button should start disabled before target inspection succeeds.",
    );
  }

  const deadline = Date.now() + timeoutMs;
  while (await connectButton.isDisabled()) {
    if (Date.now() > deadline) {
      throw new Error("[browser-smoke] Connect button did not become ready in time.");
    }
    await page.waitForTimeout(100);
  }
}
`.trim();
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const webUiUrl = `http://127.0.0.1:${options.uiPort}`;
  const cacheRoot = path.join(DEFAULT_PLAYWRIGHT_CLI_CACHE_ROOT, options.sessionName);
  const npmCacheDir = path.join(cacheRoot, "npm-cache");
  const playwrightConfigPath = path.join(options.outDir, "playwright-cli.config.json");
  const npmEnv = createPlaywrightCliEnv(npmCacheDir, playwrightConfigPath, {
    browserCacheRoot: options.playwrightCacheRoot,
  });
  const screenshots = {
    initial: path.join(options.outDir, "initial-connect.png"),
    afterTurn: path.join(options.outDir, "after-first-turn.png"),
    overlays: path.join(options.outDir, "overlay-flows.png"),
    debug: path.join(options.outDir, "debug-trace.png"),
    afterRestore: path.join(options.outDir, "after-restore-prefs.png"),
  };

  await mkdir(npmCacheDir, { recursive: true });
  await ensureNpxAvailable(
    [
      '[browser-smoke] "npx" is required for the local Playwright CLI path.',
      "Install Node.js/npm so `npx` is available, then retry.",
    ].join("\n"),
    npmEnv,
  );
  await ensurePlaywrightBrowser("chromium", npmEnv);
  await removePath(options.outDir, { recursive: true, force: true });
  await mkdir(options.outDir, { recursive: true });
  await mkdir(npmCacheDir, { recursive: true });
  await writeFile(
    playwrightConfigPath,
    `${JSON.stringify(
      buildPlaywrightCliConfig({
        headed: options.headed,
        outputDir: options.outDir,
      }),
      null,
      2,
    )}\n`,
  );

  const { buildAgentCard, serveACPOverA2A } = await import("@agents-js/a2a");

  const gateway = await serveACPOverA2A({
    acp: {
      command: "node",
      args: [mockAgentPath],
    },
    agentCard: buildAgentCard({
      name: "browser-smoke-gateway",
      description: "Deterministic mock-backed gateway for browser smoke checks",
      capabilities: { "text-to-text": {} },
    }),
    host: gatewayHost,
    port: 0,
  });
  const gatewayUrl = `http://${gatewayHost}:${gateway.port}`;
  const webUiUrlWithOverride = `${webUiUrl}/?target=${encodeURIComponent(gatewayUrl)}`;
  const webUiLogLines: string[] = [];

  await assertPortAvailable(gatewayHost, options.uiPort, "web-ui dev server");

  const webUiProc = spawnLogged(
    "browser-smoke:web-ui",
    [
      "vp",
      "run",
      "@agents-js/web-ui#dev",
      "--host",
      "127.0.0.1",
      "--port",
      String(options.uiPort),
      "--strictPort",
    ],
    {
      cwd: repoRoot,
      env: buildProcessEnv(),
      onStdoutLine(line) {
        webUiLogLines.push(line);
        if (webUiLogLines.length > 40) {
          webUiLogLines.shift();
        }
      },
      onStderrLine(line) {
        webUiLogLines.push(line);
        if (webUiLogLines.length > 40) {
          webUiLogLines.shift();
        }
      },
    },
  );

  try {
    console.log("[browser-smoke] waiting for gateway and web-ui");
    await waitForHttp(`${gatewayUrl}/.well-known/agent-card.json`, "mock gateway");
    const webUiExitError = webUiProc.exited.then((code) => {
      throw new Error(
        [
          `[browser-smoke] web-ui dev server exited before the local URL was ready (code ${code}).`,
          webUiLogLines.length > 0 ? webUiLogLines.join("\n") : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    });
    await Promise.race([waitForHttp(webUiUrl, "web UI dev server"), webUiExitError]);

    console.log("[browser-smoke] opening Playwright session");
    await openPlaywrightSession(options.sessionName, { env: npmEnv });

    console.log("[browser-smoke] verifying initial connect dialog");
    await runPlaywright(
      [
        `-s=${options.sessionName}`,
        "run-code",
        buildInitialCode({
          webUiUrl: webUiUrlWithOverride,
          gatewayUrl,
        }),
      ],
      { timeoutMs: playwrightStepTimeoutMs, env: npmEnv },
    );

    console.log("[browser-smoke] capturing initial screenshot");
    await runPlaywright(
      [`-s=${options.sessionName}`, "screenshot", "--filename", screenshots.initial, "--full-page"],
      { timeoutMs: playwrightScreenshotTimeoutMs, env: npmEnv },
    );

    console.log("[browser-smoke] connecting to the mock gateway");
    await runPlaywright(
      [
        `-s=${options.sessionName}`,
        "run-code",
        `
async (page) => {
  const timeoutMs = 10_000;
  const requireVisible = async (locator) => locator.waitFor({ state: "visible", timeout: timeoutMs });

  const connectDialog = page.locator("acp-connect-dialog");
  const connectButton = connectDialog.getByRole("button", { name: "Connect" });
  await requireVisible(connectButton);
  await connectButton.click();

  await requireVisible(page.locator("acp-status-bar"));
  await requireVisible(page.locator("acp-transcript"));
  await requireVisible(page.locator("acp-prompt-input textarea"));
}
`.trim(),
      ],
      { timeoutMs: playwrightStepTimeoutMs, env: npmEnv },
    );

    console.log("[browser-smoke] sending a prompt turn");
    await runPlaywright(
      [
        `-s=${options.sessionName}`,
        "run-code",
        `
async (page) => {
  const prompt = ${JSON.stringify("Hello from browser smoke")};
  const timeoutMs = 10_000;
  const requireVisible = async (locator) => locator.waitFor({ state: "visible", timeout: timeoutMs });

  const promptInput = page.locator("acp-prompt-input textarea");
  await requireVisible(promptInput);
  await promptInput.fill(prompt);
  await promptInput.press("Enter");

  const userBubble = page.locator(".bubble--user").last();
  const agentBubble = page.locator(".bubble--agent").last();
  await requireVisible(userBubble);
  await requireVisible(agentBubble);

  const userText = (await userBubble.textContent()) ?? "";
  if (!userText.includes(prompt)) {
    throw new Error("[browser-smoke] Expected the transcript to include the user prompt.");
  }

  const agentText = (await agentBubble.textContent()) ?? "";
  if (!agentText.includes("Mock ACP Agent")) {
    throw new Error("[browser-smoke] Expected the transcript to include the mock agent reply.");
  }
}
`.trim(),
      ],
      { timeoutMs: playwrightStepTimeoutMs, env: npmEnv },
    );

    console.log("[browser-smoke] capturing post-turn screenshot");
    await runPlaywright(
      [
        `-s=${options.sessionName}`,
        "screenshot",
        "--filename",
        screenshots.afterTurn,
        "--full-page",
      ],
      { timeoutMs: playwrightScreenshotTimeoutMs, env: npmEnv },
    );

    console.log("[browser-smoke] exercising elicitation and auth overlays");
    await runPlaywright(
      [
        `-s=${options.sessionName}`,
        "run-code",
        `
async (page) => {
  const timeoutMs = 20_000;
  const requireVisible = async (locator) => locator.waitFor({ state: "visible", timeout: timeoutMs });
  const waitForAgentText = async (expected) => {
    const deadline = Date.now() + timeoutMs;
    const agentBubble = page.locator(".bubble--agent").last();
    while (Date.now() < deadline) {
      const text = ((await agentBubble.textContent()) ?? "").trim();
      if (text.includes(expected)) {
        return;
      }
      await page.waitForTimeout(100);
    }
    throw new Error("[browser-smoke] Timed out waiting for agent text: " + expected);
  };
  const sendPrompt = async (text) => {
    const promptInput = page.locator("acp-prompt-input textarea");
    await requireVisible(promptInput);
    await promptInput.fill(text);
    await promptInput.press("Enter");
  };

  await sendPrompt("browser smoke elicitation accept");

  const elicitationForm = page.locator("acp-elicitation-form");
  await requireVisible(elicitationForm);
  await elicitationForm.getByRole("button", { name: "Accept" }).click();
  await requireVisible(elicitationForm.locator(".error-text"));

  await elicitationForm.locator("input#topic").fill("release readiness");
  await elicitationForm.locator("input#urgent").check();
  await elicitationForm.locator("input#priority").fill("3");
  await elicitationForm.getByRole("button", { name: "Accept" }).click();

  await waitForAgentText("Elicitation accepted for release readiness.");

  await sendPrompt("browser smoke elicitation decline");
  await requireVisible(elicitationForm);
  await elicitationForm.getByRole("button", { name: "Decline" }).click();
  await waitForAgentText("Elicitation declined by the browser smoke fixture.");

  await sendPrompt("browser smoke elicitation cancel");
  await requireVisible(elicitationForm);
  await elicitationForm.getByRole("button", { name: "Cancel" }).click();
  await waitForAgentText("Elicitation cancelled by the browser smoke fixture.");

  await sendPrompt("browser smoke auth");

  const authSelector = page.locator("acp-auth-selector");
  await requireVisible(authSelector);
  const authButton = authSelector.getByRole("button", { name: /Browser auth/i });
  await requireVisible(authButton);
  await authButton.click();

  await waitForAgentText("Authentication accepted via browser-auth.");
}
`.trim(),
      ],
      { timeoutMs: 60_000, env: npmEnv },
    );

    console.log("[browser-smoke] capturing overlay screenshot");
    await runPlaywright(
      [
        `-s=${options.sessionName}`,
        "screenshot",
        "--filename",
        screenshots.overlays,
        "--full-page",
      ],
      { timeoutMs: playwrightScreenshotTimeoutMs, env: npmEnv },
    );

    console.log("[browser-smoke] opening the debug panel");
    await runPlaywright(
      [
        `-s=${options.sessionName}`,
        "run-code",
        `
async (page) => {
  const timeoutMs = 10_000;
  const requireVisible = async (locator) => locator.waitFor({ state: "visible", timeout: timeoutMs });

  const debugPanel = page.locator("acp-debug-panel");
  await requireVisible(debugPanel);

  const sessionTab = debugPanel.getByRole("button", { name: "Session" });
  await requireVisible(sessionTab);
  await sessionTab.click();
  await requireVisible(debugPanel.locator(".content .row"));

  const traceTab = debugPanel.getByRole("button", { name: "Trace" });
  await requireVisible(traceTab);
  await traceTab.click();
  await requireVisible(debugPanel.locator("table"));
}
`.trim(),
      ],
      { timeoutMs: playwrightStepTimeoutMs, env: npmEnv },
    );

    console.log("[browser-smoke] capturing debug screenshot");
    await runPlaywright(
      [`-s=${options.sessionName}`, "screenshot", "--filename", screenshots.debug, "--full-page"],
      { timeoutMs: playwrightScreenshotTimeoutMs, env: npmEnv },
    );

    // -- Save preferences & verify restore after page reload (R9) --
    console.log("[browser-smoke] saving preferences");
    await runPlaywright(
      [
        `-s=${options.sessionName}`,
        "run-code",
        `
async (page) => {
  const timeoutMs = 10_000;
  const requireVisible = async (locator) => locator.waitFor({ state: "visible", timeout: timeoutMs });

  // Navigate back to connect dialog via Settings button
  const settingsBtn = page.getByRole("button", { name: "Settings" });
  await requireVisible(settingsBtn);
  await settingsBtn.click();

  // Wait for connect dialog to appear
  const connectDialog = page.locator("acp-connect-dialog");
  await requireVisible(connectDialog);

  // Click "Save as Default" (no active profile in a fresh session)
  const saveBtn = connectDialog.getByRole("button", { name: "Save as Default" });
  await requireVisible(saveBtn);
  await saveBtn.click();

  // After saving, activeProfileId is set so the button text becomes "Save Profile"
  // and the btn-save--active class is added.
  await connectDialog.getByRole("button", { name: "Save Profile" })
    .waitFor({ state: "visible", timeout: timeoutMs });
}
`.trim(),
      ],
      { timeoutMs: playwrightStepTimeoutMs, env: npmEnv },
    );

    console.log("[browser-smoke] reloading and verifying restore");
    await runPlaywright(
      [
        `-s=${options.sessionName}`,
        "run-code",
        `
async (page) => {
  const timeoutMs = 10_000;
  const requireVisible = async (locator) => locator.waitFor({ state: "visible", timeout: timeoutMs });

  // Reload the page
  await page.reload({ waitUntil: "domcontentloaded" });

  // Wait for connect dialog to reappear
  const connectDialog = page.locator("acp-connect-dialog");
  await requireVisible(connectDialog);

  // Verify the URL input has the saved URL (exact match)
  const connectInput = connectDialog.locator(".url-row input[type=\\"text\\"]");
  await requireVisible(connectInput);
  const restoredUrl = await connectInput.inputValue();
  const expectedUrl = "${gatewayUrl}";
  if (restoredUrl !== expectedUrl) {
    throw new Error(
      "[browser-smoke] Expected saved URL '" + expectedUrl + "', got: '" + restoredUrl + "'",
    );
  }

  // Verify profile was restored — button says "Save Profile" (active profile loaded)
  const saveBtn = connectDialog.getByRole("button", { name: "Save Profile" });
  await requireVisible(saveBtn);
}
`.trim(),
      ],
      { timeoutMs: playwrightStepTimeoutMs, env: npmEnv },
    );

    console.log("[browser-smoke] capturing restore screenshot");
    await runPlaywright(
      [
        `-s=${options.sessionName}`,
        "screenshot",
        "--filename",
        screenshots.afterRestore,
        "--full-page",
      ],
      { timeoutMs: playwrightScreenshotTimeoutMs, env: npmEnv },
    );

    console.log("[browser-smoke] exporting browser console entries");
    const consoleEntries = await runPlaywrightJson<BrowserConsoleEntry[]>(
      options.sessionName,
      buildBrowserConsoleExportCode(),
      { timeoutMs: 15_000, env: npmEnv },
      "[browser-smoke]",
    );
    const wsNoise = consoleEntries.filter((entry) => {
      const text = entry.text ?? "";
      return /WebSocket|ws:\/\//i.test(text);
    });
    if (wsNoise.length > 0) {
      throw new Error(
        `[browser-smoke] Unexpected websocket console noise without an explicit ?ws launch param: ${wsNoise.map((entry) => entry.text).join(" | ")}`,
      );
    }

    const consoleDiagnostics = classifyBrowserConsoleEntries(
      consoleEntries.filter((entry) => !wsNoise.includes(entry)),
    );
    if (
      consoleDiagnostics.unexpectedWarnings.length > 0 ||
      consoleDiagnostics.unexpectedErrors.length > 0
    ) {
      const diagnostics = [
        ...consoleDiagnostics.unexpectedWarnings.map(
          (entry) => `warn:${entry.text ?? "<missing warning text>"}`,
        ),
        ...consoleDiagnostics.unexpectedErrors.map(
          (entry) => `error:${entry.text ?? "<missing error text>"}`,
        ),
      ];
      throw new Error(
        `[browser-smoke] Unexpected browser console diagnostics: ${diagnostics.join(" | ")}`,
      );
    }

    const summary = {
      command: `bun run ${options.commandName}`,
      gatewayUrl,
      configuredConnectUrl: gatewayUrl,
      webUiUrl,
      screenshots: {
        initial: toPosix(path.relative(repoRoot, screenshots.initial)),
        afterTurn: toPosix(path.relative(repoRoot, screenshots.afterTurn)),
        overlays: toPosix(path.relative(repoRoot, screenshots.overlays)),
        debug: toPosix(path.relative(repoRoot, screenshots.debug)),
        afterRestore: toPosix(path.relative(repoRoot, screenshots.afterRestore)),
      },
      checks: [
        "connect dialog visible",
        "connect dialog respects the configured ?target= override",
        "connect button enables after controller-driven target inspection succeeds",
        "connected chat layout rendered",
        "prompt input sends one turn",
        "transcript shows user and agent messages",
        "elicitation accept validates required fields and resumes the turn",
        "elicitation decline and cancel both resume the turn deterministically",
        "auth selector renders advertised methods and resumes after selection",
        "no derived websocket bridge is attempted without an explicit ?ws launch param",
        "debug panel session and trace views rendered",
        "save preferences persists URL to localStorage",
        "page reload restores saved preferences",
      ],
    };

    await writeFile(
      path.join(options.outDir, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );

    console.log(
      [
        "[browser-smoke] mock gateway: ok",
        `[browser-smoke] web-ui: ${webUiUrl}`,
        `[browser-smoke] screenshots: ${summary.screenshots.initial}, ${summary.screenshots.afterTurn}, ${summary.screenshots.overlays}, ${summary.screenshots.debug}, ${summary.screenshots.afterRestore}`,
      ].join("\n"),
    );
  } finally {
    void cleanupPlaywrightSession(options.sessionName, npmEnv).catch(() => {});
    stopProcess(webUiProc);
    gateway.stop();
  }
}

if (import.meta.main) {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
