import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "../cli-args.ts";

/**
 * The internal-gateway exposes its own argv parser (it does not share
 * the published CLI's table-driven parser). The release-readiness work
 * adds `--trust-workspace` here so the gate that controls
 * `.agents-js/permission-rules.json` loading has a CLI surface.
 *
 * The trust gate is a security boundary: an ambiguous truthy coercion
 * (e.g. `=1`, `=yes`) must NOT cross it — only the literal string
 * `"true"` or the explicit flag.
 */
describe("parseCliArgs — workspace trust gate", () => {
  test("default — trustWorkspace is false when flag absent and env unset", () => {
    expect(parseCliArgs([], {}).trustWorkspace).toBe(false);
  });

  test("--trust-workspace flag enables trust", () => {
    expect(parseCliArgs(["--trust-workspace"], {}).trustWorkspace).toBe(true);
  });

  test("AGENTS_JS_TRUST_WORKSPACE=true env enables trust", () => {
    expect(parseCliArgs([], { AGENTS_JS_TRUST_WORKSPACE: "true" }).trustWorkspace).toBe(true);
  });

  test("env values other than the literal 'true' do NOT enable trust", () => {
    for (const value of ["1", "yes", "TRUE", "True", "on", " true ", ""]) {
      expect(parseCliArgs([], { AGENTS_JS_TRUST_WORKSPACE: value }).trustWorkspace).toBe(false);
    }
  });

  test("flag wins over env when both are set", () => {
    expect(
      parseCliArgs(["--trust-workspace"], { AGENTS_JS_TRUST_WORKSPACE: "false" }).trustWorkspace,
    ).toBe(true);
  });

  test("does not break existing flags — workspace and permission-mode still parse", () => {
    const args = parseCliArgs(
      ["--trust-workspace", "--workspace", "/tmp/ws", "--permission-mode", "bypassPermissions"],
      {},
    );
    expect(args.workspace).toBe("/tmp/ws");
    expect(args.permissionMode).toBe("bypassPermissions");
    expect(args.trustWorkspace).toBe(true);
  });

  test("`--permission-mode unattended-gateway` (kebab CLI form) is accepted", () => {
    expect(parseCliArgs(["--permission-mode", "unattended-gateway"], {}).permissionMode).toBe(
      "unattendedGateway",
    );
  });

  test("`--permission-mode unattendedGateway` (canonical camelCase) is accepted", () => {
    expect(parseCliArgs(["--permission-mode", "unattendedGateway"], {}).permissionMode).toBe(
      "unattendedGateway",
    );
  });

  test("unknown permission mode is still rejected", () => {
    expect(() => parseCliArgs(["--permission-mode", "not-a-mode"], {})).toThrow(
      /Invalid permission mode/,
    );
  });
});

describe("parseCliArgs — registry sync gate", () => {
  test("default — registrySync is false when flag absent and env unset", () => {
    expect(parseCliArgs([], {}).registrySync).toBe(false);
  });

  test("--registry-sync flag enables sync", () => {
    expect(parseCliArgs(["--registry-sync"], {}).registrySync).toBe(true);
  });

  test("AGENTS_JS_REGISTRY_SYNC=true env enables sync", () => {
    expect(parseCliArgs([], { AGENTS_JS_REGISTRY_SYNC: "true" }).registrySync).toBe(true);
  });

  test("env values other than the literal 'true' do NOT enable sync", () => {
    for (const value of ["1", "yes", "TRUE", "True", "on", " true ", ""]) {
      expect(parseCliArgs([], { AGENTS_JS_REGISTRY_SYNC: value }).registrySync).toBe(false);
    }
  });

  test("flag wins over env when both are set", () => {
    expect(
      parseCliArgs(["--registry-sync"], { AGENTS_JS_REGISTRY_SYNC: "false" }).registrySync,
    ).toBe(true);
  });

  test("registrySync and trustWorkspace gates are independent", () => {
    const both = parseCliArgs(["--registry-sync", "--trust-workspace"], {});
    expect(both.registrySync).toBe(true);
    expect(both.trustWorkspace).toBe(true);

    const onlyRegistry = parseCliArgs(["--registry-sync"], {});
    expect(onlyRegistry.registrySync).toBe(true);
    expect(onlyRegistry.trustWorkspace).toBe(false);

    const onlyTrust = parseCliArgs(["--trust-workspace"], {});
    expect(onlyTrust.registrySync).toBe(false);
    expect(onlyTrust.trustWorkspace).toBe(true);
  });
});

describe("parseCliArgs — host-address heartbeat (AJS-87)", () => {
  test("default — heartbeat enabled, intervalMs unset (helper applies 60s)", () => {
    const args = parseCliArgs([], {});
    expect(args.heartbeatEnabled).toBe(true);
    expect(args.heartbeatIntervalMs).toBeUndefined();
  });

  test("--no-heartbeat disables the loop", () => {
    expect(parseCliArgs(["--no-heartbeat"], {}).heartbeatEnabled).toBe(false);
  });

  test("--heartbeat-enabled is the explicit-on counterpart", () => {
    expect(parseCliArgs(["--heartbeat-enabled"], {}).heartbeatEnabled).toBe(true);
  });

  test("--heartbeat-interval-ms sets the cadence", () => {
    expect(parseCliArgs(["--heartbeat-interval-ms", "15000"], {}).heartbeatIntervalMs).toBe(15_000);
  });

  test("AGENTS_JS_HEARTBEAT_INTERVAL_MS env overrides default when CLI flag absent", () => {
    expect(
      parseCliArgs([], { AGENTS_JS_HEARTBEAT_INTERVAL_MS: "120000" }).heartbeatIntervalMs,
    ).toBe(120_000);
  });

  test("AGENTS_JS_HEARTBEAT_ENABLED=false disables; CLI flag wins when both set", () => {
    expect(parseCliArgs([], { AGENTS_JS_HEARTBEAT_ENABLED: "false" }).heartbeatEnabled).toBe(false);
    expect(
      parseCliArgs(["--heartbeat-enabled"], { AGENTS_JS_HEARTBEAT_ENABLED: "false" })
        .heartbeatEnabled,
    ).toBe(true);
  });

  test("AGENTS_JS_HEARTBEAT_ENABLED rejects non-boolean strings", () => {
    expect(() => parseCliArgs([], { AGENTS_JS_HEARTBEAT_ENABLED: "1" })).toThrow(
      /AGENTS_JS_HEARTBEAT_ENABLED/,
    );
  });

  test("AGENTS_JS_HEARTBEAT_INTERVAL_MS rejects non-numeric values", () => {
    expect(() => parseCliArgs([], { AGENTS_JS_HEARTBEAT_INTERVAL_MS: "later" })).toThrow(
      /AGENTS_JS_HEARTBEAT_INTERVAL_MS/,
    );
  });

  test("--heartbeat-interval-ms rejects negative values", () => {
    expect(() => parseCliArgs(["--heartbeat-interval-ms", "-1"], {})).toThrow(
      /--heartbeat-interval-ms/,
    );
  });

  test("--no-heartbeat and --heartbeat-enabled — last flag wins", () => {
    expect(parseCliArgs(["--no-heartbeat", "--heartbeat-enabled"], {}).heartbeatEnabled).toBe(true);
    expect(parseCliArgs(["--heartbeat-enabled", "--no-heartbeat"], {}).heartbeatEnabled).toBe(
      false,
    );
  });
});

describe("parseCliArgs — public gateway URL", () => {
  test("--public-url sets the externally advertised gateway URL without touching hostname", () => {
    const args = parseCliArgs(
      ["--hostname", "0.0.0.0", "--public-url", "http://agents-gateway.q4m.dev:9321"],
      {},
    );

    expect(args.hostname).toBe("0.0.0.0");
    expect(args.publicUrl).toBe("http://agents-gateway.q4m.dev:9321/");
  });

  test("AGENTS_JS_PUBLIC_URL sets the externally advertised gateway URL", () => {
    expect(
      parseCliArgs([], { AGENTS_JS_PUBLIC_URL: "http://agents-gateway.q4m.dev:9321" }).publicUrl,
    ).toBe("http://agents-gateway.q4m.dev:9321/");
  });

  test("--public-url wins over AGENTS_JS_PUBLIC_URL", () => {
    expect(
      parseCliArgs(["--public-url", "http://cli.example:9321"], {
        AGENTS_JS_PUBLIC_URL: "http://env.example:9321",
      }).publicUrl,
    ).toBe("http://cli.example:9321/");
  });

  test("--public-url rejects non-HTTP(S) URLs", () => {
    expect(() => parseCliArgs(["--public-url", "ws://agents-gateway.q4m.dev:9321"], {})).toThrow(
      /http:\/\/ or https:\/\//,
    );
  });

  test("--public-url without a value throws", () => {
    expect(() => parseCliArgs(["--public-url"], {})).toThrow(/Missing value for "--public-url"/);
  });
});

/**
 * The internal-gateway accepts `--runtime <id>` (repeatable, single
 * value) AND `--runtimes <id1,id2>` (comma-separated). Both forms
 * populate `runtimeOverrides: readonly string[]` in argv order.
 * Index 0 is the primary routing target. Single-runtime invocations
 * (`--runtime opencode` alone) produce a 1-element array so
 * downstream consumers reading `runtimeOverrides[0]` get
 * byte-identical behavior to the original single-runtime form.
 */
describe("parseCliArgs — multi-runtime selection", () => {
  test("default — runtimeOverrides is empty when no runtime flag present", () => {
    expect(parseCliArgs([], {}).runtimeOverrides).toEqual([]);
  });

  test("single `--runtime opencode` yields a 1-element list (back-compat)", () => {
    expect(parseCliArgs(["--runtime", "opencode"], {}).runtimeOverrides).toEqual(["opencode"]);
  });

  test("repeated `--runtime` flag pushes in argv order", () => {
    expect(
      parseCliArgs(["--runtime", "opencode", "--runtime", "gemini"], {}).runtimeOverrides,
    ).toEqual(["opencode", "gemini"]);
  });

  test("`--runtimes a,b,c` splits on commas and trims whitespace", () => {
    expect(parseCliArgs(["--runtimes", " opencode , gemini ,codex"], {}).runtimeOverrides).toEqual([
      "opencode",
      "gemini",
      "codex",
    ]);
  });

  test("mixed `--runtime` and `--runtimes` forms preserve argv order", () => {
    expect(
      parseCliArgs(["--runtimes", "a,b", "--runtime", "c", "--runtimes", "d,e"], {})
        .runtimeOverrides,
    ).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("`--runtimes` rejects an empty entry between commas", () => {
    expect(() => parseCliArgs(["--runtimes", "a,,b"], {})).toThrow(/empty entry/);
  });

  test("`--runtimes` rejects a value with only a comma", () => {
    expect(() => parseCliArgs(["--runtimes", ","], {})).toThrow(/empty entry/);
  });

  test("`--runtime` without a value throws", () => {
    expect(() => parseCliArgs(["--runtime"], {})).toThrow(/Missing value for "--runtime"/);
  });

  test("`--runtimes` without a value throws", () => {
    expect(() => parseCliArgs(["--runtimes"], {})).toThrow(/Missing value for "--runtimes"/);
  });
});

/**
 * `--card-name` (AJS-86): explicit per-instance override for the
 * advertised agent-card `name`. Required when two gateway processes
 * co-host the same runtime+profile on one machine and the per-runtime
 * default (`<runtime>[-<profile>]-acp-gateway`) is still ambiguous.
 */
describe("parseCliArgs — --card-name", () => {
  test("default — cardName is undefined when flag absent and env unset", () => {
    expect(parseCliArgs([], {}).cardName).toBeUndefined();
  });

  test("--card-name flag sets the override", () => {
    expect(parseCliArgs(["--card-name", "hostname-null-ajs-pi-0"], {}).cardName).toBe(
      "hostname-null-ajs-pi-0",
    );
  });

  test("AGENTS_JS_CARD_NAME env sets the override", () => {
    expect(parseCliArgs([], { AGENTS_JS_CARD_NAME: "env-acp-gateway" }).cardName).toBe(
      "env-acp-gateway",
    );
  });

  test("flag wins over env when both are set", () => {
    expect(
      parseCliArgs(["--card-name", "flag-wins"], { AGENTS_JS_CARD_NAME: "env-loses" }).cardName,
    ).toBe("flag-wins");
  });

  test("env values that are blank / whitespace-only are treated as unset", () => {
    expect(parseCliArgs([], { AGENTS_JS_CARD_NAME: "" }).cardName).toBeUndefined();
    expect(parseCliArgs([], { AGENTS_JS_CARD_NAME: "   " }).cardName).toBeUndefined();
  });

  test("--card-name without a value throws", () => {
    expect(() => parseCliArgs(["--card-name"], {})).toThrow(/Missing value for "--card-name"/);
  });

  test("--card-name with a whitespace-only value throws", () => {
    expect(() => parseCliArgs(["--card-name", "   "], {})).toThrow(
      /--card-name requires a non-empty value/,
    );
  });
});
