import { describe, expect, test } from "bun:test";
import {
  buildLauncherOpenUrl,
  extractGatewayUrl,
  extractGatewayWsUrl,
  extractLauncherWebUiUrl,
  extractOpenUrl,
} from "../scripts/browser-launch-contract.ts";
import { buildBrowserSmokeArgv, classifyBrowserConsoleEntries } from "../scripts/browser-smoke.ts";
import { buildDeterministicGateArgv, buildLiveWebGateArgv } from "../scripts/e2e.ts";
import { buildDeterministicWebMockArgv } from "../scripts/e2e-deterministic.ts";
import { resolveRuntimeE2EOutcome } from "../scripts/e2e-runtime.ts";
import {
  createLiveWebE2EFailure,
  detectLiveWebE2EFailureFromLine,
  toLiveWebE2EFailure,
} from "../scripts/live-web-e2e-failures.ts";
import {
  buildPlaywrightCliConfig,
  buildPlaywrightSessionBootstrapArgv,
  buildPlaywrightSessionReadyArgv,
  createPlaywrightCliEnv,
  DEFAULT_PLAYWRIGHT_BROWSER_CACHE_ROOT,
  DEFAULT_PLAYWRIGHT_CLI_CWD,
  openPlaywrightSessionWithDeps,
  PLAYWRIGHT_SESSION_BOOTSTRAP_MAX_ATTEMPTS,
  PLAYWRIGHT_SESSION_BOOTSTRAP_TIMEOUT_MS,
  PLAYWRIGHT_SESSION_READY_TIMEOUT_MS,
  resolvePlaywrightCliCwd,
  shouldRetryPlaywrightSessionBootstrap,
  shouldRetryPlaywrightSessionReady,
} from "../scripts/playwright-cli.ts";
import {
  extractRuntimeE2EProofChecks,
  extractRuntimeE2EResult,
  formatRuntimeE2EResult,
  parseRuntimeE2EResultLine,
  type RuntimeE2EResultContract,
} from "../scripts/runtime-e2e-contract.ts";

const runtimeSuccessResult: RuntimeE2EResultContract = {
  classification: "passed",
  contractVersion: 1,
  failureCode: null,
  failureMessage: null,
  passed: true,
  profile: "clean-room",
  runtime: "claude",
};

describe("runtime e2e result contract", () => {
  test("formats and parses a success result line", () => {
    const line = formatRuntimeE2EResult(runtimeSuccessResult);
    expect(parseRuntimeE2EResultLine(line)).toEqual({
      status: "ok",
      result: runtimeSuccessResult,
    });
  });

  test("extracts the final structured result from mixed output", () => {
    const output = [
      "[runtime-e2e] runtime: claude",
      "[runtime-e2e] base-url flow: ok",
      formatRuntimeE2EResult(runtimeSuccessResult),
    ].join("\n");

    expect(extractRuntimeE2EResult(output)).toEqual({
      status: "ok",
      result: runtimeSuccessResult,
    });
  });

  test("treats missing result lines as a contract failure", () => {
    expect(extractRuntimeE2EResult("[runtime-e2e] base-url flow: ok")).toEqual({
      status: "missing",
    });
  });

  test("treats malformed result lines as a contract failure", () => {
    const malformed = '[runtime-e2e:result] {"contractVersion":1,"passed":true}';
    expect(parseRuntimeE2EResultLine(malformed)).toEqual({
      status: "malformed",
      value: '{"contractVersion":1,"passed":true}',
    });
  });

  test("extracts the headless harness proof markers from mixed output", () => {
    const output = [
      "[runtime-e2e] runtime: claude",
      "[runtime-e2e] contamination check: clean",
      "[runtime-e2e] runtime boot: ok",
      "[runtime-e2e] session bootstrap: ok",
      "[runtime-e2e] prompt round-trip: ok",
      "[runtime-e2e] base-url flow: ok",
      "[runtime-e2e] card-url flow: ok",
      "[runtime-e2e] streaming: validated via capability flag",
      formatRuntimeE2EResult(runtimeSuccessResult),
    ].join("\n");

    expect(extractRuntimeE2EProofChecks(output)).toEqual({
      runtimeBoot: true,
      contaminationCheck: true,
      sessionBootstrap: true,
      promptRoundTrip: true,
      baseUrlFlow: true,
      cardUrlFlow: true,
      streamingCapability: true,
    });
  });
});

describe("runtime wrapper classification", () => {
  test("uses the structured failure contract when the child lane fails", () => {
    const output = formatRuntimeE2EResult({
      classification: "acp-contamination-problem",
      contractVersion: 1,
      failureCode: "acp_stdout_contamination",
      failureMessage: "Stdout contamination detected",
      passed: false,
      profile: null,
      runtime: "claude",
    });

    expect(resolveRuntimeE2EOutcome(output, false)).toEqual({
      classification: "acp-contamination-problem",
      resultContract: {
        classification: "acp-contamination-problem",
        contractVersion: 1,
        failureCode: "acp_stdout_contamination",
        failureMessage: "Stdout contamination detected",
        passed: false,
        profile: null,
        runtime: "claude",
      },
      resultContractStatus: "ok",
      resultContractValue: null,
    });
  });

  test("treats missing result contracts as gateway contract failures", () => {
    expect(resolveRuntimeE2EOutcome("[runtime-e2e] base-url flow: ok", false)).toEqual({
      classification: "gateway-a2a-contract-problem",
      resultContract: null,
      resultContractStatus: "missing",
      resultContractValue: null,
    });
  });

  test("treats malformed result contracts as gateway contract failures", () => {
    expect(
      resolveRuntimeE2EOutcome('[runtime-e2e:result] {"contractVersion":1,"passed":true}', false),
    ).toEqual({
      classification: "gateway-a2a-contract-problem",
      resultContract: null,
      resultContractStatus: "malformed",
      resultContractValue: '{"contractVersion":1,"passed":true}',
    });
  });
});

describe("browser launcher discovery parsing", () => {
  test("builds the canonical Open URL with explicit ?target and ?ws params", () => {
    expect(
      buildLauncherOpenUrl(
        "http://127.0.0.1:5173/",
        "http://127.0.0.1:61001",
        "ws://127.0.0.1:61002",
      ),
    ).toBe(
      "http://127.0.0.1:5173/?target=http%3A%2F%2F127.0.0.1%3A61001&ws=ws%3A%2F%2F127.0.0.1%3A61002",
    );
  });

  test("extracts the printed discovery URLs from dev output", () => {
    expect(extractGatewayUrl("[dev] Gateway URL: http://127.0.0.1:61001")).toBe(
      "http://127.0.0.1:61001",
    );
    expect(extractGatewayWsUrl("[dev] Gateway WS URL: ws://127.0.0.1:61002")).toBe(
      "ws://127.0.0.1:61002",
    );
    expect(extractLauncherWebUiUrl("[dev] Web UI URL: http://localhost:5173/")).toBe(
      "http://localhost:5173/",
    );
    expect(
      extractOpenUrl(
        "[dev] Open URL: http://localhost:5173/?target=http%3A%2F%2F127.0.0.1%3A61001&ws=ws%3A%2F%2F127.0.0.1%3A61002",
      ),
    ).toBe(
      "http://localhost:5173/?target=http%3A%2F%2F127.0.0.1%3A61001&ws=ws%3A%2F%2F127.0.0.1%3A61002",
    );
  });
});

describe("live web e2e failure helpers", () => {
  test("classifies local port contention separately from proof-surface failures", () => {
    const failure = detectLiveWebE2EFailureFromLine(
      "error: listen EADDRINUSE: address already in use 127.0.0.1:5173",
    );
    expect(failure?.failureCode).toBe("launcher_port_contention");
    expect(failure?.classification).toBe("environment-contention");
  });

  test("classifies runtime resolution failures explicitly", () => {
    const failure = detectLiveWebE2EFailureFromLine(
      '[Gateway] Runtime "claude" could not resolve executable "claude-agent-acp".',
    );
    expect(failure?.failureCode).toBe("runtime_unavailable");
    expect(failure?.classification).toBe("runtime-availability-config-problem");
  });

  test("converts proof-surface failures into explicit typed errors", () => {
    const failure = toLiveWebE2EFailure(
      createLiveWebE2EFailure(
        "proof_surface_failure",
        "[e2e:web:live] Missing JSON marker in Playwright output.",
      ),
    );
    expect(failure.failureCode).toBe("proof_surface_failure");
    expect(failure.classification).toBe("proof-surface");
  });
});

describe("playwright cache propagation", () => {
  test("uses the Chromium channel so headless runs avoid the legacy headless-shell path", () => {
    expect(buildPlaywrightCliConfig({ headed: false, outputDir: "/tmp/out" })).toMatchObject({
      browser: {
        browserName: "chromium",
        launchOptions: {
          channel: "chromium",
          headless: true,
        },
      },
    });
  });

  test("passes the shared cache flag into the browser smoke lane", () => {
    expect(
      buildBrowserSmokeArgv({
        headed: true,
        outDir: "/tmp/mock-out",
        playwrightCacheRoot: "/tmp/shared-browser-cache",
      }),
    ).toEqual([
      "bun",
      "scripts/browser-smoke.ts",
      "--out-dir",
      "/tmp/mock-out",
      "--headed",
      "--playwright-cache-root",
      "/tmp/shared-browser-cache",
    ]);
  });

  test("passes the shared cache flag through the deterministic gate", () => {
    expect(
      buildDeterministicWebMockArgv({
        headed: true,
        playwrightCacheRoot: "/tmp/shared-browser-cache",
      }),
    ).toEqual([
      "bun",
      "run",
      "browser:smoke",
      "--",
      "--headed",
      "--playwright-cache-root",
      "/tmp/shared-browser-cache",
    ]);
  });

  test("passes the shared cache flag through the top-level e2e gate", () => {
    expect(
      buildDeterministicGateArgv({
        headed: false,
        playwrightCacheRoot: "/tmp/shared-browser-cache",
      }),
    ).toEqual([
      "bun",
      "run",
      "e2e:deterministic",
      "--",
      "--playwright-cache-root",
      "/tmp/shared-browser-cache",
    ]);

    expect(
      buildLiveWebGateArgv({
        headed: true,
        playwrightCacheRoot: "/tmp/shared-browser-cache",
        runtime: "claude",
      }),
    ).toEqual([
      "bun",
      "run",
      "e2e:web:live",
      "--",
      "--runtime",
      "claude",
      "--headed",
      "--playwright-cache-root",
      "/tmp/shared-browser-cache",
    ]);
  });
});

describe("browser smoke console diagnostics", () => {
  test("allows the known Lit dev-mode warning in the Vite-backed smoke lane", () => {
    const result = classifyBrowserConsoleEntries([
      {
        level: "warn",
        text: "Lit is in dev mode. Not recommended for production! See https://lit.dev/msg/dev-mode for more information.",
      },
    ]);

    expect(result.expectedWarnings).toHaveLength(1);
    expect(result.unexpectedWarnings).toEqual([]);
    expect(result.unexpectedErrors).toEqual([]);
  });

  test("flags change-in-update warnings as unexpected browser smoke failures", () => {
    const result = classifyBrowserConsoleEntries([
      {
        level: "warn",
        text: "Element acp-chat-app scheduled an update after an update completed.",
      },
    ]);

    expect(result.expectedWarnings).toEqual([]);
    expect(result.unexpectedWarnings).toEqual([
      {
        level: "warn",
        text: "Element acp-chat-app scheduled an update after an update completed.",
      },
    ]);
  });
});

describe("playwright bootstrap helper", () => {
  test("defaults Playwright CLI subprocesses to an isolated cwd", () => {
    // What: repo-owned Playwright npx calls do not run from the package checkout by default.
    // Why: npm reads root package metadata from cwd, and this repo intentionally uses Bun-style overrides.
    expect(resolvePlaywrightCliCwd()).toBe(DEFAULT_PLAYWRIGHT_CLI_CWD);
    expect(resolvePlaywrightCliCwd("/tmp/custom-playwright-cwd")).toBe(
      "/tmp/custom-playwright-cwd",
    );
  });

  test("uses the canonical browser smoke bootstrap command and waits for readiness", async () => {
    const cleanupCalls: string[] = [];
    const runCalls: Array<{
      argv: string[];
      timeoutMs?: number;
      allowFailure?: boolean;
    }> = [];

    await openPlaywrightSessionWithDeps(
      "browser-smoke",
      {
        cleanup: async (sessionName) => {
          cleanupCalls.push(sessionName);
        },
        run: async (argv, options = {}) => {
          runCalls.push({
            allowFailure: options.allowFailure,
            argv,
            timeoutMs: options.timeoutMs,
          });
          return {
            code: 0,
            stderr: "",
            stdout: "",
            timedOut: false,
          };
        },
      },
      {
        env: { PLAYWRIGHT_DAEMON_SESSION_DIR: "/tmp/mock-daemon" },
      },
    );

    expect(buildPlaywrightSessionBootstrapArgv("browser-smoke")).toEqual([
      "-s=browser-smoke",
      "open",
      "about:blank",
    ]);
    expect(buildPlaywrightSessionReadyArgv("browser-smoke")).toEqual([
      "-s=browser-smoke",
      "run-code",
      "async (page) => page.url()",
    ]);
    expect(cleanupCalls).toEqual(["browser-smoke"]);
    expect(runCalls).toEqual([
      {
        allowFailure: true,
        argv: ["-s=browser-smoke", "open", "about:blank"],
        timeoutMs: PLAYWRIGHT_SESSION_BOOTSTRAP_TIMEOUT_MS,
      },
      {
        allowFailure: true,
        argv: ["-s=browser-smoke", "run-code", "async (page) => page.url()"],
        timeoutMs: PLAYWRIGHT_SESSION_READY_TIMEOUT_MS,
      },
      {
        allowFailure: true,
        argv: ["-s=browser-smoke", "run-code", "async (page) => page.url()"],
        timeoutMs: PLAYWRIGHT_SESSION_READY_TIMEOUT_MS,
      },
    ]);
  });

  test("retries bootstrap once after cleanup when the first attempt times out", async () => {
    const cleanupCalls: string[] = [];
    let attempt = 0;

    await openPlaywrightSessionWithDeps("browser-smoke", {
      cleanup: async (sessionName) => {
        cleanupCalls.push(sessionName);
      },
      run: async () => {
        attempt += 1;
        return attempt === 1
          ? {
              code: -1,
              stderr: "",
              stdout: "",
              timedOut: true,
            }
          : {
              code: 0,
              stderr: "",
              stdout: "",
              timedOut: false,
            };
      },
    });

    expect(attempt).toBe(PLAYWRIGHT_SESSION_BOOTSTRAP_MAX_ATTEMPTS + 2);
    expect(cleanupCalls).toEqual(["browser-smoke", "browser-smoke"]);
  });

  test("retries only for timeout or non-zero exit results", () => {
    expect(shouldRetryPlaywrightSessionBootstrap({ code: 0, timedOut: false })).toBe(false);
    expect(shouldRetryPlaywrightSessionBootstrap({ code: 1, timedOut: false })).toBe(true);
    expect(shouldRetryPlaywrightSessionBootstrap({ code: 0, timedOut: true })).toBe(true);
  });

  test("retries readiness only when the browser is still opening", () => {
    expect(
      shouldRetryPlaywrightSessionReady({
        code: 0,
        stderr: "",
        stdout: "",
        timedOut: false,
      }),
    ).toBe(false);
    expect(
      shouldRetryPlaywrightSessionReady({
        code: 1,
        stderr: "",
        stdout: "The browser 'browser-smoke' is not open, please run open first",
        timedOut: false,
      }),
    ).toBe(true);
    expect(
      shouldRetryPlaywrightSessionReady({
        code: 1,
        stderr: "Target page, context or browser has been closed",
        stdout: "",
        timedOut: false,
      }),
    ).toBe(false);
    expect(
      shouldRetryPlaywrightSessionReady({
        code: 1,
        stderr: "",
        stdout: "",
        timedOut: true,
      }),
    ).toBe(true);
  });

  test("retries readiness polling before succeeding when the browser is still opening", async () => {
    const cleanupCalls: string[] = [];
    const runCalls: string[][] = [];
    let attempt = 0;

    await openPlaywrightSessionWithDeps(
      "browser-smoke",
      {
        cleanup: async (sessionName) => {
          cleanupCalls.push(sessionName);
        },
        run: async (argv, _options = {}) => {
          runCalls.push(argv);
          if (argv[1] === "open") {
            return {
              code: 0,
              stderr: "",
              stdout: "",
              timedOut: false,
            };
          }

          attempt += 1;
          return attempt === 1
            ? {
                code: 1,
                stderr: "",
                stdout: "The browser 'browser-smoke' is not open, please run open first",
                timedOut: false,
              }
            : {
                code: 0,
                stderr: "",
                stdout: "",
                timedOut: false,
              };
        },
        sleep: async () => {},
      },
      {
        env: { PLAYWRIGHT_DAEMON_SESSION_DIR: "/tmp/mock-daemon" },
      },
    );

    expect(cleanupCalls).toEqual(["browser-smoke"]);
    expect(runCalls).toEqual([
      ["-s=browser-smoke", "open", "about:blank"],
      ["-s=browser-smoke", "run-code", "async (page) => page.url()"],
      ["-s=browser-smoke", "run-code", "async (page) => page.url()"],
      ["-s=browser-smoke", "run-code", "async (page) => page.url()"],
    ]);
  });

  test("uses a stable default browser cache root when no override is provided", () => {
    expect(
      createPlaywrightCliEnv("/tmp/mock-npm-cache", "/tmp/playwright.config.json"),
    ).toMatchObject({
      PLAYWRIGHT_BROWSERS_PATH: `${DEFAULT_PLAYWRIGHT_BROWSER_CACHE_ROOT}/ms-playwright-browsers`,
    });
  });
});
