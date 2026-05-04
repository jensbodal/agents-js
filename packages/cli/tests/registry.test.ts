import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { runRegistryCommand } from "../src/registry.ts";

function captureStderr(fn: () => number): { code: number; stderr: string } {
  const original = console.error;
  let stderr = "";
  console.error = (...args: unknown[]) => {
    stderr += `${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}\n`;
  };
  try {
    const code = fn();
    return { code, stderr };
  } finally {
    console.error = original;
  }
}

/**
 * The registry CLI uses AGENTS_JS_REGISTRY to resolve its config path.
 * Each test gets an isolated tmp dir so writes don't leak across cases.
 */
let tmpDir: string;
let prevRegistry: string | undefined;
let registryPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cli-registry-test-"));
  registryPath = join(tmpDir, "registry.json");
  prevRegistry = process.env.AGENTS_JS_REGISTRY;
  process.env.AGENTS_JS_REGISTRY = registryPath;
});

afterEach(() => {
  if (prevRegistry === undefined) {
    delete process.env.AGENTS_JS_REGISTRY;
  } else {
    process.env.AGENTS_JS_REGISTRY = prevRegistry;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function readRegistry(): {
  agents: Record<string, Record<string, unknown>>;
} {
  return JSON.parse(readFileSync(registryPath, "utf-8"));
}

describe("runRegistryCommand", () => {
  test("add with no flags defaults to kind=a2a (positional url)", () => {
    const code = runRegistryCommand(["add", "alpha", "http://alpha.test"]);
    expect(code).toBe(0);
    const registry = readRegistry();
    expect(registry.agents.alpha).toMatchObject({ kind: "a2a", url: "http://alpha.test" });
  });

  test("add --kind a2a --url variant", () => {
    const code = runRegistryCommand(["add", "beta", "--kind", "a2a", "--url", "http://beta.test"]);
    expect(code).toBe(0);
    const registry = readRegistry();
    expect(registry.agents.beta).toMatchObject({ kind: "a2a", url: "http://beta.test" });
  });

  test("add --kind acp --harness stores an ACP entry", () => {
    const code = runRegistryCommand([
      "add",
      "reviewer",
      "--kind",
      "acp",
      "--harness",
      "claude",
      "--command",
      "claude-agent-acp",
      "--args-json",
      '["--debug"]',
      "--env-json",
      '{"CLAUDE_LOG_LEVEL":"debug"}',
      "--workspace-flag",
      "--cwd",
    ]);
    expect(code).toBe(0);
    const registry = readRegistry();
    expect(registry.agents.reviewer).toMatchObject({
      kind: "acp",
      harness: "claude",
      command: "claude-agent-acp",
      args: ["--debug"],
      env: { CLAUDE_LOG_LEVEL: "debug" },
      workspaceFlag: "--cwd",
    });
  });

  test("add --kind acp without --harness fails with exit 1", () => {
    const code = runRegistryCommand(["add", "broken", "--kind", "acp"]);
    expect(code).toBe(1);
  });

  test("add --kind with invalid value fails", () => {
    const code = runRegistryCommand(["add", "broken", "--kind", "mystery"]);
    expect(code).toBe(1);
  });

  test("add --kind a2a without url fails", () => {
    const code = runRegistryCommand(["add", "broken", "--kind", "a2a"]);
    expect(code).toBe(1);
  });

  test("add --kind acp --args-json must be valid JSON array of strings", () => {
    const code = runRegistryCommand([
      "add",
      "broken",
      "--kind",
      "acp",
      "--harness",
      "claude",
      "--args-json",
      "not-json",
    ]);
    expect(code).toBe(1);
  });

  test("remove deletes an entry", () => {
    runRegistryCommand(["add", "alpha", "http://alpha.test"]);
    const code = runRegistryCommand(["remove", "alpha"]);
    expect(code).toBe(0);
    const registry = readRegistry();
    expect(registry.agents.alpha).toBeUndefined();
  });

  test("list returns 0 for empty registry", () => {
    const code = runRegistryCommand(["list"]);
    expect(code).toBe(0);
  });

  test("add strips zero-width-space from the agent name", () => {
    // A ZWSP-prefixed name would otherwise persist a key the gateway's
    // normalized session-controller view can never look up. See
    // docs/architecture/opencode-zwsp-tracking.md for the upstream context.
    const code = runRegistryCommand(["add", "\u200bsisyphus", "http://s.test"]);
    expect(code).toBe(0);
    const registry = readRegistry();
    expect(registry.agents["\u200bsisyphus"]).toBeUndefined();
    expect(registry.agents.sisyphus).toMatchObject({ kind: "a2a", url: "http://s.test" });
  });

  test("add rejects a name that is empty after normalization", () => {
    // A name consisting solely of default-ignorable characters is
    // unrecoverable — reject it at registry-add time rather than persist
    // an empty-string key.
    const code = runRegistryCommand(["add", "\u200b\u200c", "http://bad.test"]);
    expect(code).toBe(1);
  });

  test("remove normalizes the target name symmetrically with add", () => {
    runRegistryCommand(["add", "alpha", "http://alpha.test"]);
    // User can pass a ZWSP-polluted variant — it is normalized before
    // lookup so the entry is still deletable.
    const code = runRegistryCommand(["remove", "\u200balpha"]);
    expect(code).toBe(0);
    const registry = readRegistry();
    expect(registry.agents.alpha).toBeUndefined();
  });

  test("missing value for --kind fails at parse time with a clear message", () => {
    const { code, stderr } = captureStderr(() => runRegistryCommand(["add", "myagent", "--kind"]));
    expect(code).toBe(1);
    // Parser-level error, not the delayed post-parse validation.
    expect(stderr).toContain("Missing value for --kind");
  });

  test("missing value for --harness fails at parse time with a clear message", () => {
    const { code, stderr } = captureStderr(() =>
      runRegistryCommand(["add", "myagent", "--kind", "acp", "--harness"]),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("Missing value for --harness");
  });

  test("invalid --kind value surfaces the a2a|acp constraint", () => {
    const { code, stderr } = captureStderr(() =>
      runRegistryCommand(["add", "myagent", "--kind", "invalid"]),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("--kind must be one of a2a|acp");
    expect(stderr).toContain('got "invalid"');
  });

  test("positional <url> form still works for a2a back-compat", () => {
    const code = runRegistryCommand(["add", "legacy", "http://legacy.test"]);
    expect(code).toBe(0);
    const registry = readRegistry();
    expect(registry.agents.legacy).toMatchObject({ kind: "a2a", url: "http://legacy.test" });
  });

  test("unknown flag on `registry add` surfaces a clear error", () => {
    const { code, stderr } = captureStderr(() =>
      runRegistryCommand(["add", "myagent", "--bogus", "x"]),
    );
    expect(code).toBe(1);
    expect(stderr).toContain('Unknown flag "--bogus"');
  });

  test("overflow positional beyond <name> <url> is rejected", () => {
    const { code, stderr } = captureStderr(() =>
      runRegistryCommand(["add", "myagent", "http://a.test", "extra"]),
    );
    expect(code).toBe(1);
    expect(stderr).toContain('Unexpected positional argument "extra"');
  });

  test("add writes v2 provenance fields (source=manual, gateway_id=hostname)", () => {
    const code = runRegistryCommand(["add", "alpha", "http://alpha.test"]);
    expect(code).toBe(0);
    const onDisk = readRegistry() as unknown as {
      version?: number;
      agents: Record<string, Record<string, unknown>>;
    };
    expect(onDisk.version).toBe(2);
    const entry = onDisk.agents.alpha;
    expect(entry).toBeDefined();
    if (!entry) throw new Error("missing entry");
    expect(entry.kind).toBe("a2a");
    expect(entry.url).toBe("http://alpha.test");
    expect(entry.source).toBe("manual");
    expect(entry.actor_type).toBe("machine");
    expect(entry.gateway_id).toBe(hostname());
    expect(entry.agent_id).toBe(`${hostname()}.alpha`);
    expect(typeof entry.registered_at).toBe("string");
    expect(() => new Date(entry.registered_at as string).toISOString()).not.toThrow();
  });

  test("add preserves existing v2 records (does not drop siblings)", () => {
    runRegistryCommand(["add", "alpha", "http://alpha.test"]);
    runRegistryCommand(["add", "beta", "http://beta.test"]);
    const onDisk = readRegistry();
    expect(Object.keys(onDisk.agents).sort()).toEqual(["alpha", "beta"]);
  });

  test("add upgrades a pre-existing v1 file to v2 on next write", () => {
    // Simulate a legacy v1 file on disk.
    writeFileSync(
      registryPath,
      JSON.stringify({
        agents: { legacy: { kind: "a2a", url: "http://legacy.test" } },
      }),
    );
    const code = runRegistryCommand(["add", "fresh", "http://fresh.test"]);
    expect(code).toBe(0);
    const onDisk = readRegistry() as unknown as {
      version?: number;
      agents: Record<string, Record<string, unknown>>;
    };
    expect(onDisk.version).toBe(2);
    // Legacy entry preserved verbatim; fresh entry has provenance fields.
    expect(onDisk.agents.legacy).toMatchObject({ kind: "a2a", url: "http://legacy.test" });
    expect(onDisk.agents.fresh).toMatchObject({
      kind: "a2a",
      url: "http://fresh.test",
      source: "manual",
      actor_type: "machine",
    });
  });
});
