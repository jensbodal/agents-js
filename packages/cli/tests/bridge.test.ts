import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServeACPOverA2AHandle, ServeACPOverA2AOptions } from "@agents-js/a2a";
import type { RuntimeCommandResolver } from "@agents-js/gateway-runtime";
import {
  bridgeArgsToRuntimeEnvOverrides,
  parseBridgeCommandArgs,
  runBridgeCommand,
} from "../src/bridge.ts";

// Duplicated from tests/mcp.test.ts per synthesis Open-Q8 (defer helper extraction).
function makeOutputBuffer() {
  let content = "";
  return {
    get value() {
      return content;
    },
    write(chunk: string) {
      content += chunk;
      return true;
    },
  };
}

// Duplicated from tests/mcp.test.ts per synthesis Open-Q8 (defer helper extraction).
function withTempDir(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-js-bridge-test-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function makeStubHandle(port = 45678): ServeACPOverA2AHandle & { stopCalls: number } {
  const handle = {
    stopCalls: 0,
    port,
    server: {
      port,
      stop() {},
    },
    stop() {
      handle.stopCalls += 1;
    },
  };
  return handle;
}

const opencodeResolver: RuntimeCommandResolver = {
  which(command) {
    if (command === "opencode") return "/usr/local/bin/opencode";
    return undefined;
  },
  async fileExists() {
    return false;
  },
};

const claudeResolver: RuntimeCommandResolver = {
  which(command) {
    if (command === "claude-agent-acp") return "/usr/local/bin/claude-agent-acp";
    return undefined;
  },
  async fileExists() {
    return false;
  },
};

describe("parseBridgeCommandArgs", () => {
  test("returns empty args for no arguments", () => {
    expect(parseBridgeCommandArgs([])).toEqual({});
  });

  test("parses --help", () => {
    expect(parseBridgeCommandArgs(["--help"]).help).toBe(true);
  });

  test("parses -h", () => {
    expect(parseBridgeCommandArgs(["-h"]).help).toBe(true);
  });

  test("parses --harness opencode", () => {
    expect(parseBridgeCommandArgs(["--harness", "opencode"]).harness).toBe("opencode");
  });

  test("parses --host 0.0.0.0", () => {
    expect(parseBridgeCommandArgs(["--host", "0.0.0.0"]).host).toBe("0.0.0.0");
  });

  test("parses --port 7890", () => {
    expect(parseBridgeCommandArgs(["--port", "7890"]).port).toBe(7890);
  });

  test("parses --port 0 (auto-allocate)", () => {
    expect(parseBridgeCommandArgs(["--port", "0"]).port).toBe(0);
  });

  test("parses --runtime-log-level debug", () => {
    expect(parseBridgeCommandArgs(["--runtime-log-level", "debug"]).runtimeLogLevel).toBe("debug");
  });

  test("parses --opencode-disable-external-plugins", () => {
    expect(
      parseBridgeCommandArgs(["--opencode-disable-external-plugins"])
        .opencodeDisableExternalPlugins,
    ).toBe(true);
  });

  test("throws on unknown argument", () => {
    expect(() => parseBridgeCommandArgs(["--bogus"])).toThrow("Unknown bridge argument");
  });

  test("throws on --harness missing value", () => {
    expect(() => parseBridgeCommandArgs(["--harness"])).toThrow("Missing value for --harness");
  });

  test("throws on --port out of range", () => {
    expect(() => parseBridgeCommandArgs(["--port", "99999"])).toThrow(
      "--port must be an integer between 0 and 65535",
    );
  });

  test("throws on --port non-integer", () => {
    expect(() => parseBridgeCommandArgs(["--port", "abc"])).toThrow(
      "--port must be an integer between 0 and 65535",
    );
  });

  test("throws on --runtime-log-level unknown", () => {
    expect(() => parseBridgeCommandArgs(["--runtime-log-level", "trace"])).toThrow(
      "--runtime-log-level must be one of",
    );
  });
});

describe("bridgeArgsToRuntimeEnvOverrides", () => {
  test("maps runtimeLogLevel / opencodeDisableExternalPlugins", () => {
    const overrides = bridgeArgsToRuntimeEnvOverrides({
      runtimeLogLevel: "debug",
      opencodeDisableExternalPlugins: true,
    });
    expect(overrides).toEqual({
      runtimeLogLevel: "debug",
      disableExternalPlugins: true,
    });
  });

  test("leaves unset fields undefined", () => {
    const overrides = bridgeArgsToRuntimeEnvOverrides({});
    expect(overrides.runtimeLogLevel).toBeUndefined();
    expect(overrides.disableExternalPlugins).toBeUndefined();
  });
});

describe("runBridgeCommand", () => {
  test("prints help and exits 0", async () => {
    const output = makeOutputBuffer();
    const result = await runBridgeCommand(["--help"], { output });
    expect(result).toBe(0);
    expect(output.value).toContain("agents-js v");
    expect(output.value).toContain("bridge");
    expect(output.value).toContain("--harness");
  });

  test("returns 1 with clear message when --harness missing", async () => {
    const output = makeOutputBuffer();
    const result = await runBridgeCommand([], { output });
    expect(result).toBe(1);
    expect(output.value).toContain("Missing required --harness");
  });

  test("returns 1 when --harness is not a known runtime", async () => {
    const output = makeOutputBuffer();
    const result = await runBridgeCommand(["--harness", "bogus"], { output });
    expect(result).toBe(1);
    expect(output.value).toContain("Unknown runtime");
    expect(output.value).toContain("bogus");
  });

  test("invokes serveGateway with resolved runtime acp + agentCard", async () => {
    const output = makeOutputBuffer();
    const calls: ServeACPOverA2AOptions[] = [];
    const handle = makeStubHandle(45678);

    const result = await runBridgeCommand(["--harness", "opencode", "--port", "0"], {
      output,
      runtimeResolver: opencodeResolver,
      serveGateway: async (opts) => {
        calls.push(opts);
        return handle;
      },
      waitForShutdown: async () => {},
    });

    expect(typeof result).not.toBe("number");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.acp?.command).toBe("/usr/local/bin/opencode");
    expect(calls[0]?.agentCard.name).toBe("opencode-acp-gateway");
    expect(calls[0]?.host).toBe("127.0.0.1");
    expect(calls[0]?.port).toBe(0);
  });

  test(
    "applies env overrides before runtime resolution and restores after",
    withTempDir(async () => {
      const output = makeOutputBuffer();
      const envKeysToSnapshot = [
        "AJS_DEFAULT_MODEL",
        "AJS_RUNTIME_LOG_LEVEL",
        "AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS",
      ];
      const before = Object.fromEntries(envKeysToSnapshot.map((k) => [k, process.env[k]]));
      let observedDuringResolve: Record<string, string | undefined> | undefined;

      const resolver: RuntimeCommandResolver = {
        which(command) {
          observedDuringResolve = Object.fromEntries(
            envKeysToSnapshot.map((k) => [k, process.env[k]]),
          );
          if (command === "opencode") return "/usr/local/bin/opencode";
          return undefined;
        },
        async fileExists() {
          return false;
        },
      };

      await runBridgeCommand(
        [
          "--harness",
          "opencode",
          "--runtime-log-level",
          "debug",
          "--opencode-disable-external-plugins",
        ],
        {
          output,
          runtimeResolver: resolver,
          serveGateway: async () => makeStubHandle(),
          waitForShutdown: async () => {},
        },
      );

      expect(observedDuringResolve?.AJS_RUNTIME_LOG_LEVEL).toBe("debug");
      expect(observedDuringResolve?.AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS).toBe("1");

      const after = Object.fromEntries(envKeysToSnapshot.map((k) => [k, process.env[k]]));
      expect(after).toEqual(before);
    }),
  );

  test("writes bridge-serving line with displayName and bound port", async () => {
    const output = makeOutputBuffer();
    const handle = makeStubHandle(40999);

    await runBridgeCommand(["--harness", "claude", "--port", "0"], {
      output,
      runtimeResolver: claudeResolver,
      serveGateway: async () => handle,
      waitForShutdown: async () => {},
    });

    expect(output.value).toContain("bridge serving Claude ACP");
    expect(output.value).toContain("http://127.0.0.1:40999");
  });

  test("reports server.port (not args.port) when args.port is 0", async () => {
    const output = makeOutputBuffer();
    const handle = makeStubHandle(52000);

    const result = await runBridgeCommand(["--harness", "opencode", "--port", "0"], {
      output,
      runtimeResolver: opencodeResolver,
      serveGateway: async () => handle,
      waitForShutdown: async () => {},
    });

    expect(output.value).toContain(":52000");
    expect(typeof result).not.toBe("number");
    if (typeof result !== "number") {
      expect(result.port).toBe(52000);
    }
  });

  test("waitForShutdown resolves, stop() called, result returned", async () => {
    const output = makeOutputBuffer();
    const handle = makeStubHandle(40100);

    const result = await runBridgeCommand(["--harness", "opencode"], {
      output,
      runtimeResolver: opencodeResolver,
      serveGateway: async () => handle,
      waitForShutdown: async () => {},
    });

    expect(handle.stopCalls).toBe(1);
    expect(typeof result).not.toBe("number");
    if (typeof result !== "number") {
      expect(result.host).toBe("127.0.0.1");
      expect(result.port).toBe(40100);
      expect(result.server).toBe(handle);
      expect(result.runtime.definition.id).toBe("opencode");
    }
  });

  test("host defaults to 127.0.0.1 when --host omitted", async () => {
    const output = makeOutputBuffer();
    const calls: ServeACPOverA2AOptions[] = [];

    await runBridgeCommand(["--harness", "opencode"], {
      output,
      runtimeResolver: opencodeResolver,
      serveGateway: async (opts) => {
        calls.push(opts);
        return makeStubHandle();
      },
      waitForShutdown: async () => {},
    });

    expect(calls[0]?.host).toBe("127.0.0.1");
  });

  test("port defaults to 0 when --port omitted", async () => {
    const output = makeOutputBuffer();
    const calls: ServeACPOverA2AOptions[] = [];

    await runBridgeCommand(["--harness", "opencode"], {
      output,
      runtimeResolver: opencodeResolver,
      serveGateway: async (opts) => {
        calls.push(opts);
        return makeStubHandle();
      },
      waitForShutdown: async () => {},
    });

    expect(calls[0]?.port).toBe(0);
  });

  test("rejects unknown harness with supported-runtimes guidance", async () => {
    const output = makeOutputBuffer();
    const result = await runBridgeCommand(["--harness", "custom"], { output });
    expect(result).toBe(1);
    // Custom is not a curated harness; bridge rejects it.
    expect(output.value).toContain("Unknown runtime");
  });
});
