#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type GatewayRuntimeId, getGatewayRuntimeDefinition } from "@agents-js/gateway-runtime";
import {
  E2E_RUNTIME_PROFILE_DATA_HOME_ENV,
  E2E_RUNTIME_PROFILE_STATE_HOME_ENV,
} from "@agents-js/host";
import { gatewayConfig } from "../apps/internal-gateway/gateway.config.ts";
import {
  buildBrowserConsoleExportCode,
  buildBrowserConsoleInitScript,
} from "./browser-console-capture.ts";
import {
  extractGatewayUrl,
  extractGatewayWsUrl,
  extractLauncherWebUiUrl,
  extractOpenUrl,
} from "./browser-launch-contract.ts";
import { createEphemeralRuntimeProfileSandbox } from "./ephemeral-runtime-profiles.ts";
import {
  createLiveWebE2EFailure,
  detectLiveWebE2EFailureFromLine,
  LiveWebE2EFailure,
  type LiveWebE2EFailureClassification,
  type LiveWebE2EFailureCode,
} from "./live-web-e2e-failures.ts";
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
  buildProcessEnv,
  captureProcessStreamToFile,
  stopProcess,
  waitForHttp,
} from "./process-utils.ts";
import { repoRoot } from "./workspace-config.ts";

type BrowserConsoleEntry = {
  level: string;
  text: string;
};

type LiveWebE2ECheck = {
  data?: unknown;
  detail?: string;
  name: string;
  status: "failed" | "passed" | "skipped";
};

type LiveWebE2EOptions = {
  headed: boolean;
  includeRuntimeSwitchCheck: boolean;
  outDir: string;
  playwrightCacheRoot?: string;
  runtime: GatewayRuntimeId;
};

type CapturedProcess = {
  gatewayUrl: Promise<string>;
  gatewayWsUrl: Promise<string>;
  openUrl: Promise<string>;
  stderrTail: Promise<string>;
  stdoutTail: Promise<string>;
  webUiUrl: Promise<string>;
};

const defaultSessionName = "web-ui-live-e2e";
const playwrightScreenshotTimeoutMs = 30_000;

function printUsage(): void {
  console.log(
    [
      "e2e:web:live",
      "",
      "Usage:",
      "  bun scripts/web-ui-live-e2e.ts [--runtime <id>] [--headed] [--out-dir <path>] [--playwright-cache-root <path>] [--include-runtime-switch-check]",
      "",
      "Launches bun run dev with a real runtime, captures the printed web-ui URL,",
      "and drives the upstream proof surface with repo-owned isolated Playwright.",
    ].join("\n"),
  );
}

function createDeferred<T>() {
  let settled = false;
  let resolveInternal!: (value: T | PromiseLike<T>) => void;
  let rejectInternal!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveInternal = resolve;
    rejectInternal = reject;
  });

  return {
    promise,
    resolve(value: T | PromiseLike<T>) {
      if (settled) {
        return;
      }
      settled = true;
      resolveInternal(value);
    },
    reject(reason?: unknown) {
      if (settled) {
        return;
      }
      settled = true;
      rejectInternal(reason);
    },
  };
}

function parseArgs(argv: string[]): LiveWebE2EOptions {
  let runtime = getGatewayRuntimeDefinition(gatewayConfig.runtime).id;
  let headed = false;
  let includeRuntimeSwitchCheck = false;
  let outDir: string | undefined;
  let playwrightCacheRoot: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case "--runtime":
        if (!next) {
          throw createLiveWebE2EFailure(
            "missing_runtime_argument",
            '[e2e:web:live] Missing value for "--runtime".',
          );
        }
        try {
          runtime = getGatewayRuntimeDefinition(next).id;
        } catch (error) {
          throw createLiveWebE2EFailure(
            "runtime_unavailable",
            error instanceof Error ? error.message : String(error),
            error instanceof Error ? { cause: error } : undefined,
          );
        }
        index += 1;
        break;
      case "--headed":
        headed = true;
        break;
      case "--include-runtime-switch-check":
        includeRuntimeSwitchCheck = true;
        break;
      case "--out-dir":
        if (!next) {
          throw new Error('[e2e:web:live] Missing value for "--out-dir".');
        }
        outDir = path.resolve(repoRoot, next);
        index += 1;
        break;
      case "--playwright-cache-root":
        if (!next) {
          throw new Error('[e2e:web:live] Missing value for "--playwright-cache-root".');
        }
        playwrightCacheRoot = path.resolve(repoRoot, next);
        index += 1;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`[e2e:web:live] Unknown argument: ${arg}`);
    }
  }

  return {
    runtime,
    headed,
    includeRuntimeSwitchCheck,
    outDir: outDir ?? path.join(repoRoot, "output/e2e/web-ui-live", runtime),
    playwrightCacheRoot,
  };
}

function launchIntegratedDev(
  runtime: GatewayRuntimeId,
  options: {
    env?: Record<string, string>;
    stderrLogPath: string;
    stdoutLogPath: string;
  },
): {
  captured: CapturedProcess;
  proc: Bun.Subprocess<"pipe", "pipe", "inherit">;
} {
  const proc = Bun.spawn(["bun", "run", "dev", "--runtime", runtime], {
    cwd: repoRoot,
    detached: true,
    env: buildProcessEnv(options.env),
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });

  const gatewayUrl = createDeferred<string>();
  const gatewayWsUrl = createDeferred<string>();
  const webUiUrl = createDeferred<string>();
  const openUrl = createDeferred<string>();
  let observedFailure: ReturnType<typeof detectLiveWebE2EFailureFromLine> = null;

  const onLine = (line: string) => {
    observedFailure ??= detectLiveWebE2EFailureFromLine(line);

    const nextGatewayUrl = extractGatewayUrl(line);
    if (nextGatewayUrl) {
      gatewayUrl.resolve(nextGatewayUrl);
    }

    const nextGatewayWsUrl = extractGatewayWsUrl(line);
    if (nextGatewayWsUrl) {
      gatewayWsUrl.resolve(nextGatewayWsUrl);
    }

    const nextWebUiUrl = extractLauncherWebUiUrl(line);
    if (nextWebUiUrl) {
      webUiUrl.resolve(nextWebUiUrl);
    }

    const nextOpenUrl = extractOpenUrl(line);
    if (nextOpenUrl) {
      openUrl.resolve(nextOpenUrl);
    }
  };

  const stdoutTail = captureProcessStreamToFile(proc.stdout, {
    logPath: options.stdoutLogPath,
    onLine,
    target: "stdout",
    tailChars: 16_384,
  });
  const stderrTail = captureProcessStreamToFile(proc.stderr, {
    logPath: options.stderrLogPath,
    onLine,
    target: "stderr",
    tailChars: 16_384,
  });

  void proc.exited.then((code) => {
    const error =
      observedFailure ??
      createLiveWebE2EFailure(
        "launcher_exited_before_discovery",
        `[e2e:web:live] bun run dev exited before the launcher discovery contract was fully printed (code ${code}).`,
      );
    gatewayUrl.reject(error);
    gatewayWsUrl.reject(error);
    webUiUrl.reject(error);
    openUrl.reject(error);
  });

  return {
    proc,
    captured: {
      stdoutTail,
      stderrTail,
      gatewayUrl: gatewayUrl.promise,
      gatewayWsUrl: gatewayWsUrl.promise,
      webUiUrl: webUiUrl.promise,
      openUrl: openUrl.promise,
    },
  };
}

function stopDetachedLauncher(proc: Bun.Subprocess<"pipe", "pipe", "inherit">): void {
  if (Number.isInteger(proc.pid) && proc.pid > 0) {
    try {
      process.kill(-proc.pid, "SIGTERM");
      return;
    } catch {
      // Fall back to direct process termination below.
    }
  }

  stopProcess(proc);
}

function getJsonMarker(code: string): string {
  return `
async (page) => {
  ${code}
}
`.trim();
}

function buildDefaultLoadCode(webUiUrl: string, expectedGatewayUrl: string): string {
  return getJsonMarker(`
  const timeoutMs = 15_000;
  const requireVisible = async (locator) => locator.waitFor({ state: "visible", timeout: timeoutMs });
  const readConnectDialogState = async () =>
    page.evaluate(() => {
      const app = document.querySelector("acp-chat-app");
      const dialog = app?.shadowRoot?.querySelector("acp-connect-dialog");
      const dialogRoot = dialog?.shadowRoot;
      const input = dialogRoot?.querySelector('.url-row input[type="text"]');
      const button = dialogRoot?.querySelector(".btn-connect");
      const statusBox = dialogRoot?.querySelector(".status-box");
      return {
        ready: Boolean(dialog && input && button),
        actualGatewayUrl: input?.value ?? "",
        connectDisabled: button?.disabled ?? true,
        statusText: statusBox?.textContent?.trim() ?? "",
      };
    });

  await page.addInitScript(${buildBrowserConsoleInitScript()});

  await page.goto(${JSON.stringify(webUiUrl)}, { waitUntil: "domcontentloaded" });

  const connectDialog = page.locator("acp-connect-dialog");
  await requireVisible(connectDialog);
  const initialState = await readConnectDialogState();
  if (!initialState.ready) {
    throw new Error("[e2e:web:live] Connect dialog controls were not ready.");
  }
  if (initialState.actualGatewayUrl !== ${JSON.stringify(expectedGatewayUrl)}) {
    throw new Error(
      "[e2e:web:live] Expected the launcher-discovered gateway URL " +
        ${JSON.stringify(expectedGatewayUrl)} +
        ", got " +
        initialState.actualGatewayUrl,
    );
  }
  if (!initialState.connectDisabled) {
    throw new Error("[e2e:web:live] Connect button should start disabled before target inspection succeeds.");
  }

  await page.waitForFunction(
    () => {
      const app = document.querySelector("acp-chat-app");
      const button = app?.shadowRoot
        ?.querySelector("acp-connect-dialog")
        ?.shadowRoot?.querySelector(".btn-connect");
      return button instanceof HTMLButtonElement ? button.disabled === false : false;
    },
    { timeout: timeoutMs },
  );

  const finalState = await readConnectDialogState();
  return {
    defaultUrl: initialState.actualGatewayUrl,
    initialDisabled: initialState.connectDisabled,
    statusText: finalState.statusText,
  };
`);
}

function buildOpenUrlConnectCode(
  webUiUrl: string,
  openUrl: string,
  expectedGatewayUrl: string,
  expectedRuntimeId: string,
): string {
  return getJsonMarker(`
  const timeoutMs = 15_000;
  const requireVisible = async (locator) => locator.waitFor({ state: "visible", timeout: timeoutMs });
  const readRenderedStatus = async () =>
    page.evaluate(() => {
      const app = document.querySelector("acp-chat-app");
      const statusBar = app?.shadowRoot?.querySelector("acp-status-bar");
      const badge = statusBar?.shadowRoot?.querySelector(".badge");
      return badge?.textContent?.replace(/\\s+/g, " ").trim() ?? "";
    });
  const readConnectDialogState = async () =>
    page.evaluate(() => {
      const app = document.querySelector("acp-chat-app");
      const dialog = app?.shadowRoot?.querySelector("acp-connect-dialog");
      const dialogRoot = dialog?.shadowRoot;
      const input = dialogRoot?.querySelector('.url-row input[type="text"]');
      const button = dialogRoot?.querySelector(".btn-connect");
      return {
        ready: Boolean(dialog && input && button),
        actualGatewayUrl: input?.value ?? "",
        connectDisabled: button?.disabled ?? true,
      };
    });

  const stalePrefs = {
    version: "2",
    activeProfileId: "stale",
    profiles: [
      {
        id: "stale",
        name: "Stale profile",
        harnessId: "stale-runtime",
        url: "http://127.0.0.1:1",
        runtimeId: "stale-runtime",
        modelId: "stale-model",
      },
    ],
  };

  await page.goto(${JSON.stringify(webUiUrl)}, { waitUntil: "domcontentloaded" });
  await page.evaluate((prefs) => {
    localStorage.setItem("acp-connect-preferences", JSON.stringify(prefs));
  }, stalePrefs);

  await page.goto(${JSON.stringify(openUrl)}, { waitUntil: "domcontentloaded" });

  const connectDialog = page.locator("acp-connect-dialog");
  await requireVisible(connectDialog);
  const initialState = await readConnectDialogState();
  if (!initialState.ready) {
    throw new Error("[e2e:web:live] Connect dialog controls were not ready for the canonical Open URL flow.");
  }
  if (initialState.actualGatewayUrl !== ${JSON.stringify(expectedGatewayUrl)}) {
    throw new Error(
      "[e2e:web:live] Expected the launcher Open URL to override saved state with " +
        ${JSON.stringify(expectedGatewayUrl)} +
        ", got " +
        initialState.actualGatewayUrl,
    );
  }
  if (!initialState.connectDisabled) {
    throw new Error("[e2e:web:live] Connect button should remain disabled until target inspection succeeds.");
  }

  const runtimeSelect = connectDialog.locator("select.runtime-select");
  if ((await runtimeSelect.count()) > 0) {
    const runtimeValue = await runtimeSelect.inputValue();
    if (runtimeValue !== ${JSON.stringify(expectedRuntimeId)}) {
      throw new Error(
        "[e2e:web:live] Expected the canonical Open URL flow to preserve launcher runtime " +
          ${JSON.stringify(expectedRuntimeId)} +
          ", got " +
          runtimeValue,
      );
    }
  }

  await page.waitForFunction(
    () => {
      const app = document.querySelector("acp-chat-app");
      const button = app?.shadowRoot
        ?.querySelector("acp-connect-dialog")
        ?.shadowRoot?.querySelector(".btn-connect");
      return button instanceof HTMLButtonElement ? button.disabled === false : false;
    },
    { timeout: timeoutMs },
  );

  await page.evaluate(() => {
    const app = document.querySelector("acp-chat-app");
    const button = app?.shadowRoot
      ?.querySelector("acp-connect-dialog")
      ?.shadowRoot?.querySelector(".btn-connect");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("[e2e:web:live] Connect button was not found for the override flow.");
    }
    button.click();
  });
  await requireVisible(page.locator("acp-status-bar"));
  await requireVisible(page.locator("acp-transcript"));
  await requireVisible(page.locator("acp-prompt-input textarea"));

  const connectedStatus = await readRenderedStatus();
  if (connectedStatus !== "connected") {
    throw new Error(
      "[e2e:web:live] Expected the rendered status badge to show connected after connect, got " +
        connectedStatus,
    );
  }

  return {
    connected: true,
    connectedStatus,
    openUrl: ${JSON.stringify(openUrl)},
    overrideUrl: initialState.actualGatewayUrl,
  };
`);
}

function buildPromptTurnCode(prompt: string, expectedUserCount: number): string {
  return getJsonMarker(`
  const timeoutMs = 120_000;
  const requireVisible = async (locator) => locator.waitFor({ state: "visible", timeout: timeoutMs });
  const readRenderedStatus = async () =>
    page.evaluate(() => {
      const app = document.querySelector("acp-chat-app");
      const statusBar = app?.shadowRoot?.querySelector("acp-status-bar");
      const badge = statusBar?.shadowRoot?.querySelector(".badge");
      return badge?.textContent?.replace(/\\s+/g, " ").trim() ?? "";
    });
  const startStatusObserver = async () =>
    page.evaluate(() => {
      const app = document.querySelector("acp-chat-app");
      const statusBar = app?.shadowRoot?.querySelector("acp-status-bar");
      const badge = statusBar?.shadowRoot?.querySelector(".badge");
      if (!(badge instanceof HTMLElement)) {
        throw new Error("[e2e:web:live] Could not locate the rendered status badge.");
      }

      const read = () => badge.textContent?.replace(/\\s+/g, " ").trim() ?? "";
      const samples = [];
      const push = () => {
        const next = read();
        if (!next) {
          return;
        }
        if (samples[samples.length - 1] !== next) {
          samples.push(next);
        }
      };

      push();

      const observer = new MutationObserver(() => {
        push();
      });
      observer.observe(badge, {
        characterData: true,
        childList: true,
        subtree: true,
      });

      window.__agentsStatusObserver?.disconnect?.();
      window.__agentsStatusObserver = observer;
      window.__agentsStatusSamples = samples;
    });
  const stopStatusObserver = async () =>
    page.evaluate(() => {
      const observer = window.__agentsStatusObserver;
      observer?.disconnect?.();
      delete window.__agentsStatusObserver;
      return Array.isArray(window.__agentsStatusSamples) ? [...window.__agentsStatusSamples] : [];
    });

  await requireVisible(page.locator("acp-status-bar"));
  const promptInput = page.locator("acp-prompt-input textarea");
  await requireVisible(promptInput);

  const beforeStatus = await readRenderedStatus();
  if (!beforeStatus) {
    throw new Error("[e2e:web:live] Rendered status badge was empty before sending the prompt.");
  }
  await startStatusObserver();
  await promptInput.fill(${JSON.stringify(prompt)});
  await promptInput.press("Enter");

  const userBubbles = page.locator(".bubble--user");
  const agentBubbles = page.locator(".bubble--agent");

  await userBubbles.nth(${expectedUserCount - 1}).waitFor({ state: "visible", timeout: timeoutMs });
  await agentBubbles.nth(${expectedUserCount - 1}).waitFor({ state: "visible", timeout: timeoutMs });

  const userText = ((await userBubbles.nth(${expectedUserCount - 1}).textContent()) ?? "").trim();
  const agentText = ((await agentBubbles.nth(${expectedUserCount - 1}).textContent()) ?? "").trim();
  if (!userText.includes(${JSON.stringify(prompt)})) {
    throw new Error("[e2e:web:live] Transcript did not render the expected user message.");
  }
  if (!agentText) {
    throw new Error("[e2e:web:live] Transcript did not render the agent reply.");
  }
  if (
    /\\b(internal error|runtime error|unhandled error|failed to start agent|prompt failed)\\b/i.test(
      agentText,
    )
  ) {
    throw new Error(
      "[e2e:web:live] Transcript rendered an error as the agent reply: " + agentText,
    );
  }

  await page.waitForTimeout(500);

  const statusSamples = await stopStatusObserver();
  const duringStatus = statusSamples.find((value) => value !== beforeStatus) ?? beforeStatus;
  if (duringStatus === beforeStatus) {
    throw new Error("[e2e:web:live] Status bar did not change during the prompt lifecycle.");
  }

  const afterStatus = await readRenderedStatus();
  if (!afterStatus) {
    throw new Error("[e2e:web:live] Rendered status badge was empty after the prompt completed.");
  }

  return {
    afterStatus,
    beforeStatus,
    duringStatus,
    prompt: ${JSON.stringify(prompt)},
    renderedAgentText: agentText,
    renderedUserText: userText,
    statusSamples,
  };
`);
}

function buildDebugPanelCode(): string {
  return getJsonMarker(`
  const timeoutMs = 15_000;
  const requireVisible = async (locator) => locator.waitFor({ state: "visible", timeout: timeoutMs });

  const debugPanel = page.locator("acp-debug-panel");
  await requireVisible(debugPanel);

  const cardTab = debugPanel.getByRole("button", { name: "Card" });
  const sessionTab = debugPanel.getByRole("button", { name: "Session" });
  const traceTab = debugPanel.getByRole("button", { name: "Trace" });

  await requireVisible(cardTab);
  await cardTab.click();
  await requireVisible(debugPanel.locator(".content .row").first());

  await requireVisible(sessionTab);
  await sessionTab.click();
  await requireVisible(debugPanel.locator(".content .row").first());

  await requireVisible(traceTab);
  await traceTab.click();
  await requireVisible(debugPanel.locator("table"));

  return { tabs: ["Card", "Session", "Trace"] };
`);
}

function buildModelVisibilityCode(): string {
  return getJsonMarker(`
  const modelState = await page.evaluate(() => {
    const app = document.querySelector("acp-chat-app");
    if (!app) {
      throw new Error("[e2e:web:live] Could not locate acp-chat-app while reading model metadata.");
    }

    if (!("_runtimeModels" in app) || !("_models" in app)) {
      throw new Error(
        "[e2e:web:live] Connected-shell model metadata was unavailable through acp-chat-app.",
      );
    }

    const runtimeModels = app._runtimeModels;
    const sessionModels = app._models;
    return {
      runtimeModelCount: Array.isArray(runtimeModels) ? runtimeModels.length : null,
      sessionModelCount:
        sessionModels && Array.isArray(sessionModels.availableModels)
          ? sessionModels.availableModels.length
          : 0,
    };
  });

  const shellModelSelector = page.locator("acp-model-selector");
  const shellModelCount = await shellModelSelector.count();

  if (modelState.runtimeModelCount === null) {
    throw new Error("[e2e:web:live] Runtime model metadata was unexpectedly null.");
  }

  const expectedVisible = modelState.runtimeModelCount > 0 || modelState.sessionModelCount > 0;

  if (expectedVisible && shellModelCount === 0) {
    throw new Error("[e2e:web:live] Model dropdown was hidden even though the runtime advertised models.");
  }

  if (!expectedVisible && shellModelCount > 0) {
    throw new Error("[e2e:web:live] Model dropdown was visible even though the runtime did not advertise models.");
  }

  const currentModelId =
    shellModelCount > 0
      ? await shellModelSelector.locator("select").inputValue()
      : "";

  return {
    currentModelId,
    runtimeModelCount: modelState.runtimeModelCount,
    sessionModelCount: modelState.sessionModelCount,
    shellModelCount,
  };
`);
}

function buildSaveReloadCode(expectedRuntimeId: string): string {
  return getJsonMarker(`
  const timeoutMs = 20_000;
  const requireVisible = async (locator) => locator.waitFor({ state: "visible", timeout: timeoutMs });

  const settingsBtn = page.getByRole("button", { name: "Settings" });
  await requireVisible(settingsBtn);
  await settingsBtn.click();

  const connectDialog = page.locator("acp-connect-dialog");
  await requireVisible(connectDialog);

  const connectInput = connectDialog.locator(".url-row input[type=\\"text\\"]");
  await requireVisible(connectInput);
  const expectedUrl = await connectInput.inputValue();

  const runtimeSelect = connectDialog.locator("select.runtime-select");
  const modelSelect = connectDialog.locator("select.model-select");
  const expectedRuntimeId = (await runtimeSelect.count()) > 0 ? await runtimeSelect.inputValue() : "";
  const expectedModelId = (await modelSelect.count()) > 0 ? await modelSelect.inputValue() : "";

  if (expectedRuntimeId && expectedRuntimeId !== ${JSON.stringify(expectedRuntimeId)}) {
    throw new Error(
      "[e2e:web:live] Settings restore started from runtime " +
        expectedRuntimeId +
        ", expected " +
        ${JSON.stringify(expectedRuntimeId)} +
        ".",
    );
  }

  const saveButton = connectDialog.getByRole("button", { name: /Save as Default|Save Profile/ });
  await requireVisible(saveButton);
  await saveButton.click();
  await connectDialog.getByRole("button", { name: "Save Profile" }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });

  await page.reload({ waitUntil: "domcontentloaded" });

  const reloadedDialog = page.locator("acp-connect-dialog");
  await requireVisible(reloadedDialog);
  const restoredInput = reloadedDialog.locator(".url-row input[type=\\"text\\"]");
  await requireVisible(restoredInput);

  const deadline = Date.now() + timeoutMs;
  let restoredUrl = "";
  while (Date.now() < deadline) {
    restoredUrl = await restoredInput.inputValue();
    if (restoredUrl === expectedUrl) {
      break;
    }
    await page.waitForTimeout(100);
  }
  if (restoredUrl !== expectedUrl) {
    throw new Error("[e2e:web:live] Saved URL was not restored after reload.");
  }

  let restoredRuntimeId = "";
  if (expectedRuntimeId) {
    const reloadedRuntimeSelect = reloadedDialog.locator("select.runtime-select");
    await requireVisible(reloadedRuntimeSelect);
    restoredRuntimeId = await reloadedRuntimeSelect.inputValue();
    if (restoredRuntimeId !== expectedRuntimeId) {
      throw new Error("[e2e:web:live] Saved runtime was not restored after reload.");
    }
  }

  let restoredModelId = "";
  if (expectedModelId) {
    const reloadedModelSelect = reloadedDialog.locator("select.model-select");
    await requireVisible(reloadedModelSelect);
    restoredModelId = await reloadedModelSelect.inputValue();
    if (restoredModelId !== expectedModelId) {
      throw new Error("[e2e:web:live] Saved model was not restored after reload.");
    }
  }

  return {
    expectedModelId,
    expectedRuntimeId,
    expectedUrl,
    restoredModelId,
    restoredRuntimeId,
    restoredUrl,
  };
`);
}

function buildRuntimeSwitchCode(): string {
  return getJsonMarker(`
  const timeoutMs = 20_000;
  const requireVisible = async (locator) => locator.waitFor({ state: "visible", timeout: timeoutMs });
  const readDialogRuntimeId = () =>
    page.evaluate(() => {
      const app = document.querySelector("acp-chat-app");
      if (!app) {
        throw new Error("[e2e:web:live] Could not locate acp-chat-app while reading runtime metadata.");
      }

      const dialog = app.shadowRoot?.querySelector("acp-connect-dialog");
      if (!dialog || !("runtime" in dialog)) {
        throw new Error(
          "[e2e:web:live] Connect dialog runtime metadata was unavailable through acp-chat-app.shadowRoot.",
        );
      }

      if (!dialog.runtime || typeof dialog.runtime.id !== "string" || dialog.runtime.id.length === 0) {
        throw new Error("[e2e:web:live] Connect dialog runtime metadata was empty.");
      }

      return dialog.runtime.id;
    });
  const readRuntimeNoticeText = async () => {
    const notice = connectDialog.locator(".runtime-notice");
    if ((await notice.count()) === 0 || !(await notice.isVisible())) {
      return "";
    }
    return ((await notice.textContent()) ?? "").trim();
  };

  const connectDialog = page.locator("acp-connect-dialog");
  await requireVisible(connectDialog);

  const runtimeSelect = connectDialog.locator("select.runtime-select");
  if ((await runtimeSelect.count()) === 0) {
    return { available: false, reason: "runtime selector hidden" };
  }

  await requireVisible(runtimeSelect);
  const currentRuntimeId = await readDialogRuntimeId();

  const optionValues = await runtimeSelect.evaluate((select) =>
    Array.from(select.options).map((option) => option.value).filter(Boolean),
  );

  if (optionValues.length < 2) {
    return { available: false, reason: "single runtime" };
  }

  const fromRuntime = await runtimeSelect.inputValue();
  if (fromRuntime !== currentRuntimeId) {
    throw new Error(
      "[e2e:web:live] Runtime selector value did not match the applied runtime: selector=" +
        fromRuntime +
        ", applied=" +
        currentRuntimeId,
    );
  }

  const toRuntime = optionValues.find((value) => value !== currentRuntimeId);
  if (!toRuntime) {
    return { available: false, reason: "no alternate runtime" };
  }

  await runtimeSelect.selectOption(toRuntime);

  const deadline = Date.now() + timeoutMs;
  let appliedRuntime = currentRuntimeId;
  let selectedRuntime = fromRuntime;
  let noticeText = "";
  while (Date.now() < deadline) {
    appliedRuntime = await readDialogRuntimeId();
    selectedRuntime = await runtimeSelect.inputValue();
    noticeText = await readRuntimeNoticeText();
    if (appliedRuntime === toRuntime) {
      break;
    }
    const isTransientSwitchNotice = noticeText.startsWith("Switching runtime to ");
    if (
      noticeText &&
      !isTransientSwitchNotice &&
      appliedRuntime === currentRuntimeId &&
      selectedRuntime === currentRuntimeId
    ) {
      return {
        available: true,
        noticeText,
        noticeVisible: true,
        outcome: "failed-runtime",
        switchedFrom: fromRuntime,
        switchedTo: currentRuntimeId,
        attemptedRuntime: toRuntime,
      };
    }
    await page.waitForTimeout(100);
  }

  if (appliedRuntime !== toRuntime) {
    if (noticeText && appliedRuntime === currentRuntimeId && selectedRuntime === currentRuntimeId) {
      return {
        available: true,
        noticeText,
        noticeVisible: true,
        outcome: "failed-runtime",
        switchedFrom: fromRuntime,
        switchedTo: currentRuntimeId,
        attemptedRuntime: toRuntime,
      };
    }

    throw new Error(
      "[e2e:web:live] Runtime selector changed locally, but the runtime neither switched nor reported a recoverable failure.",
    );
  }

  const notice = connectDialog.locator(".runtime-notice");
  const noticeVisible = (await notice.count()) > 0 && (await notice.isVisible());
  if (noticeVisible) {
    const noticeText = ((await notice.textContent()) ?? "").trim();
    throw new Error(
      "[e2e:web:live] Idle runtime switching should not surface a runtime-applied notice, received: " +
        noticeText,
    );
  }

  return {
    available: true,
    noticeVisible: false,
    outcome: "switched",
    switchedFrom: fromRuntime,
    switchedTo: toRuntime,
  };
`);
}

async function recordCheck<T>(
  checks: LiveWebE2ECheck[],
  name: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    const data = await action();
    checks.push({ name, status: "passed", data });
    return data;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({ name, status: "failed", detail });
    if (error instanceof LiveWebE2EFailure) {
      throw error;
    }
    throw createLiveWebE2EFailure(
      "proof_surface_failure",
      detail,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const checks: LiveWebE2ECheck[] = [];
  let classification: "passed" | LiveWebE2EFailureClassification = "passed";
  let failureCode: LiveWebE2EFailureCode | null = null;
  let failureMessage: string | null = null;
  let gatewayUrl: string | null = null;
  let gatewayWsUrl: string | null = null;
  let openUrl: string | null = null;
  let webUiUrl: string | null = null;
  let browserConsole: BrowserConsoleEntry[] = [];
  const runtimeSandbox = await createEphemeralRuntimeProfileSandbox(defaultSessionName, [
    "opencode",
  ]);

  await mkdir(options.outDir, { recursive: true });

  const cacheRoot = path.join(DEFAULT_PLAYWRIGHT_CLI_CACHE_ROOT, "web-ui-live-e2e");
  const npmCacheDir = path.join(cacheRoot, "npm-cache");
  const playwrightConfigPath = path.join(options.outDir, "playwright-cli.config.json");
  const stdoutLogPath = path.join(options.outDir, "dev.stdout.log");
  const stderrLogPath = path.join(options.outDir, "dev.stderr.log");
  const screenshots = {
    afterConnect: path.join(options.outDir, "after-connect.png"),
    afterFirstTurn: path.join(options.outDir, "after-first-turn.png"),
    afterReload: path.join(options.outDir, "after-reload.png"),
    debugPanel: path.join(options.outDir, "debug-panel.png"),
    initial: path.join(options.outDir, "initial-connect.png"),
    runtimeSwitch: path.join(options.outDir, "runtime-switch.png"),
  };

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

  const npmEnv = createPlaywrightCliEnv(npmCacheDir, playwrightConfigPath, {
    browserCacheRoot: options.playwrightCacheRoot,
  });
  const { proc, captured } = launchIntegratedDev(options.runtime, {
    env: runtimeSandbox.env,
    stderrLogPath,
    stdoutLogPath,
  });

  try {
    try {
      await ensureNpxAvailable(
        '[e2e:web:live] "npx" is required for the repo-owned isolated Playwright path.',
        npmEnv,
      );
    } catch (error) {
      throw createLiveWebE2EFailure(
        "playwright_cli_unavailable",
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? { cause: error } : undefined,
      );
    }

    try {
      await ensurePlaywrightBrowser("chromium", npmEnv);
    } catch (error) {
      throw createLiveWebE2EFailure(
        "playwright_browser_install_failed",
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? { cause: error } : undefined,
      );
    }

    [gatewayUrl, gatewayWsUrl, webUiUrl, openUrl] = await Promise.race([
      Promise.all([
        captured.gatewayUrl,
        captured.gatewayWsUrl,
        captured.webUiUrl,
        captured.openUrl,
      ]),
      new Promise<[string, string, string, string]>((_, reject) => {
        setTimeout(() => {
          reject(
            createLiveWebE2EFailure(
              "launcher_discovery_timeout",
              "[e2e:web:live] Timed out waiting for bun run dev to print the discovery contract URLs.",
            ),
          );
        }, 120_000);
      }),
    ]);
    const resolvedGatewayUrl = gatewayUrl;
    const resolvedWebUiUrl = webUiUrl;
    const resolvedOpenUrl = openUrl;

    await waitForHttp(resolvedWebUiUrl, "web-ui dev server", 20_000);

    await openPlaywrightSession(defaultSessionName, { env: npmEnv });

    await recordCheck(checks, "default connect dialog", async () => {
      const result = await runPlaywrightJson<Record<string, unknown>>(
        defaultSessionName,
        buildDefaultLoadCode(resolvedWebUiUrl, resolvedGatewayUrl),
        { env: npmEnv, timeoutMs: 30_000 },
        "[e2e:web:live]",
      );
      await runPlaywright(
        [
          `-s=${defaultSessionName}`,
          "screenshot",
          "--filename",
          screenshots.initial,
          "--full-page",
        ],
        {
          env: npmEnv,
          timeoutMs: playwrightScreenshotTimeoutMs,
        },
      );
      return result;
    });

    await recordCheck(checks, "canonical Open URL connect flow", async () => {
      const result = await runPlaywrightJson<Record<string, unknown>>(
        defaultSessionName,
        buildOpenUrlConnectCode(
          resolvedWebUiUrl,
          resolvedOpenUrl,
          resolvedGatewayUrl,
          options.runtime,
        ),
        { env: npmEnv, timeoutMs: 30_000 },
        "[e2e:web:live]",
      );
      await runPlaywright(
        [
          `-s=${defaultSessionName}`,
          "screenshot",
          "--filename",
          screenshots.afterConnect,
          "--full-page",
        ],
        {
          env: npmEnv,
          timeoutMs: playwrightScreenshotTimeoutMs,
        },
      );
      return result;
    });

    await recordCheck(checks, 'prompt lifecycle: "Hello"', async () => {
      const result = await runPlaywrightJson<Record<string, unknown>>(
        defaultSessionName,
        buildPromptTurnCode("Hello", 1),
        { env: npmEnv, timeoutMs: 150_000 },
        "[e2e:web:live]",
      );
      await runPlaywright(
        [
          `-s=${defaultSessionName}`,
          "screenshot",
          "--filename",
          screenshots.afterFirstTurn,
          "--full-page",
        ],
        {
          env: npmEnv,
          timeoutMs: playwrightScreenshotTimeoutMs,
        },
      );
      return result;
    });

    await recordCheck(checks, 'prompt lifecycle: "What is the last message I sent?"', async () => {
      return runPlaywrightJson<Record<string, unknown>>(
        defaultSessionName,
        buildPromptTurnCode("What is the last message I sent?", 2),
        { env: npmEnv, timeoutMs: 150_000 },
        "[e2e:web:live]",
      );
    });

    await recordCheck(checks, "debug panel surfaces", async () => {
      const result = await runPlaywrightJson<Record<string, unknown>>(
        defaultSessionName,
        buildDebugPanelCode(),
        { env: npmEnv, timeoutMs: 30_000 },
        "[e2e:web:live]",
      );
      await runPlaywright(
        [
          `-s=${defaultSessionName}`,
          "screenshot",
          "--filename",
          screenshots.debugPanel,
          "--full-page",
        ],
        {
          env: npmEnv,
          timeoutMs: playwrightScreenshotTimeoutMs,
        },
      );
      return result;
    });

    await recordCheck(checks, "model dropdown visibility", async () => {
      return runPlaywrightJson<Record<string, unknown>>(
        defaultSessionName,
        buildModelVisibilityCode(),
        { env: npmEnv, timeoutMs: 30_000 },
        "[e2e:web:live]",
      );
    });

    await recordCheck(checks, "save settings and reload restore", async () => {
      const result = await runPlaywrightJson<Record<string, unknown>>(
        defaultSessionName,
        buildSaveReloadCode(options.runtime),
        { env: npmEnv, timeoutMs: 45_000 },
        "[e2e:web:live]",
      );
      await runPlaywright(
        [
          `-s=${defaultSessionName}`,
          "screenshot",
          "--filename",
          screenshots.afterReload,
          "--full-page",
        ],
        {
          env: npmEnv,
          timeoutMs: playwrightScreenshotTimeoutMs,
        },
      );
      return result;
    });

    if (!options.includeRuntimeSwitchCheck) {
      checks.push({
        name: "runtime switching notice behavior",
        status: "skipped",
        data: { reason: "skipped by default; pass --include-runtime-switch-check to exercise it" },
      });
    } else {
      const runtimeSwitchResult = await runPlaywrightJson<Record<string, unknown>>(
        defaultSessionName,
        buildRuntimeSwitchCode(),
        { env: npmEnv, timeoutMs: 45_000 },
        "[e2e:web:live]",
      );
      if (runtimeSwitchResult.available === false) {
        checks.push({
          name: "runtime switching notice behavior",
          status: "skipped",
          data: runtimeSwitchResult,
        });
      } else {
        checks.push({
          name: "runtime switching notice behavior",
          status: "passed",
          data: runtimeSwitchResult,
        });
        await runPlaywright(
          [
            `-s=${defaultSessionName}`,
            "screenshot",
            "--filename",
            screenshots.runtimeSwitch,
            "--full-page",
          ],
          {
            env: npmEnv,
            timeoutMs: playwrightScreenshotTimeoutMs,
          },
        );
      }
    }

    browserConsole =
      (await runPlaywrightJson<BrowserConsoleEntry[]>(
        defaultSessionName,
        buildBrowserConsoleExportCode(),
        { env: npmEnv, timeoutMs: 15_000 },
        "[e2e:web:live]",
      )) ?? [];
  } catch (error) {
    // Attempt to capture browser console before cleanup so the summary
    // includes any runtime errors (e.g. Vite externalization crashes)
    // that caused the Playwright check to time out.
    try {
      browserConsole =
        (await runPlaywrightJson<BrowserConsoleEntry[]>(
          defaultSessionName,
          buildBrowserConsoleExportCode(),
          { env: npmEnv, timeoutMs: 5_000 },
          "[e2e:web:live]",
        )) ?? [];
    } catch {
      // Session may already be dead; ignore.
    }
    const failure =
      error instanceof LiveWebE2EFailure
        ? error
        : createLiveWebE2EFailure(
            "proof_surface_failure",
            error instanceof Error ? error.message : String(error),
            error instanceof Error ? { cause: error } : undefined,
          );
    classification = failure.classification;
    failureCode = failure.failureCode;
    failureMessage = failure.message;
    throw error;
  } finally {
    await cleanupPlaywrightSession(defaultSessionName, npmEnv).catch(() => {});
    stopDetachedLauncher(proc);

    const [stdoutTail, stderrTail] = await Promise.all([
      captured.stdoutTail.catch(() => ""),
      captured.stderrTail.catch(() => ""),
    ]);

    await writeFile(
      path.join(options.outDir, "browser-console.json"),
      `${JSON.stringify(browserConsole, null, 2)}\n`,
    );

    const summary = {
      browserConsoleFile: "browser-console.json",
      checks,
      classification,
      command: "bun run e2e:web:live",
      devLogs: {
        stderr: "dev.stderr.log",
        stdout: "dev.stdout.log",
      },
      devLogTail: {
        stderr: stderrTail,
        stdout: stdoutTail,
      },
      failureCode,
      failureMessage,
      gatewayUrl,
      gatewayWsUrl,
      headed: options.headed,
      openUrl,
      outputDir: options.outDir,
      passed: classification === "passed",
      runtime: options.runtime,
      runtimeIsolation: {
        configPath: runtimeSandbox.configPath,
        dataHome: runtimeSandbox.env[E2E_RUNTIME_PROFILE_DATA_HOME_ENV] ?? "",
        profilePrefix: runtimeSandbox.profilePrefix,
        stateHome: runtimeSandbox.env[E2E_RUNTIME_PROFILE_STATE_HOME_ENV] ?? "",
      },
      screenshots: Object.fromEntries(
        Object.entries(screenshots).map(([key, value]) => [
          key,
          path.relative(options.outDir, value),
        ]),
      ),
      startedAt,
      webUiUrl,
    };

    await writeFile(
      path.join(options.outDir, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );

    await runtimeSandbox.cleanup().catch(() => {});
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
