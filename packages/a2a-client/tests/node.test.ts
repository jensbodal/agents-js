import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSharedAgentRegistry, resolveSharedAgentRegistryPath } from "../src/node.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "shared-registry-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("resolveSharedAgentRegistryPath", () => {
  test("uses process.env.AGENTS_JS_REGISTRY by default", () => {
    const previous = process.env.AGENTS_JS_REGISTRY;
    process.env.AGENTS_JS_REGISTRY = "/tmp/custom-registry.json";

    try {
      expect(resolveSharedAgentRegistryPath()).toBe("/tmp/custom-registry.json");
    } finally {
      if (previous === undefined) {
        delete process.env.AGENTS_JS_REGISTRY;
      } else {
        process.env.AGENTS_JS_REGISTRY = previous;
      }
    }
  });
});

describe("createSharedAgentRegistry", () => {
  test("fails open when the registry config is missing", async () => {
    const configPath = join(tmpDir, "nonexistent.json");
    const registry = createSharedAgentRegistry({ configPath });

    await expect(registry.resolve("broken")).resolves.toBeNull();
    await expect(registry.list()).resolves.toEqual([]);
  });

  test("fails open when the registry config is invalid JSON", async () => {
    const configPath = join(tmpDir, "registry.json");
    await writeFile(configPath, "{not-json");
    const registry = createSharedAgentRegistry({ configPath });

    await expect(registry.resolve("broken")).resolves.toBeNull();
    await expect(registry.list()).resolves.toEqual([]);
  });

  test("fails open when the registry config shape is invalid", async () => {
    const configPath = join(tmpDir, "registry.json");
    await writeFile(configPath, JSON.stringify({ nope: true }));
    const registry = createSharedAgentRegistry({ configPath });

    await expect(registry.resolve("broken")).resolves.toBeNull();
    await expect(registry.list()).resolves.toEqual([]);
  });

  test("rereads the registry file on each resolve", async () => {
    const configPath = join(tmpDir, "registry.json");
    const registry = createSharedAgentRegistry({ configPath });

    await writeFile(
      configPath,
      JSON.stringify({ agents: { alpha: { url: "http://alpha.test" } } }),
    );
    await expect(registry.resolve("alpha")).resolves.toEqual({ url: "http://alpha.test" });

    await writeFile(configPath, JSON.stringify({ agents: { beta: { url: "http://beta.test" } } }));
    await expect(registry.resolve("alpha")).resolves.toBeNull();
    await expect(registry.resolve("beta")).resolves.toEqual({ url: "http://beta.test" });
  });

  test("rereads the registry file on each list", async () => {
    const configPath = join(tmpDir, "registry.json");
    await writeFile(
      configPath,
      JSON.stringify({ agents: { alpha: { url: "http://alpha.test" } } }),
    );
    const registry = createSharedAgentRegistry({ configPath });

    await expect(registry.list()).resolves.toEqual([
      { kind: "a2a", name: "alpha", url: "http://alpha.test" },
    ]);

    await writeFile(
      configPath,
      JSON.stringify({
        agents: {
          beta: { url: "http://beta.test" },
          gamma: { url: "http://gamma.test" },
        },
      }),
    );
    await expect(registry.list()).resolves.toEqual([
      { kind: "a2a", name: "beta", url: "http://beta.test" },
      { kind: "a2a", name: "gamma", url: "http://gamma.test" },
    ]);
  });

  test("list returns ACP-kind entries intact", async () => {
    const configPath = join(tmpDir, "registry.json");
    await writeFile(
      configPath,
      JSON.stringify({
        agents: {
          "acp-peer": { kind: "acp", harness: "opencode", args: ["--pure"] },
          "a2a-peer": { kind: "a2a", url: "http://a2a.test" },
        },
      }),
    );
    const registry = createSharedAgentRegistry({ configPath });

    const list = await registry.list();
    expect(list).toHaveLength(2);
    const acp = list.find((e) => e.name === "acp-peer");
    expect(acp?.kind).toBe("acp");
    if (acp?.kind === "acp") {
      expect(acp.harness).toBe("opencode");
      expect(acp.args).toEqual(["--pure"]);
    }
  });

  test("resolve skips ACP-kind entries and returns null", async () => {
    const configPath = join(tmpDir, "registry.json");
    await writeFile(
      configPath,
      JSON.stringify({
        agents: {
          "acp-peer": { kind: "acp", harness: "claude" },
        },
      }),
    );
    const registry = createSharedAgentRegistry({ configPath });

    await expect(registry.resolve("acp-peer")).resolves.toBeNull();
  });

  test("resolve returns null for unknown agent", async () => {
    const configPath = join(tmpDir, "registry.json");
    await writeFile(
      configPath,
      JSON.stringify({ agents: { alpha: { url: "http://alpha.test" } } }),
    );
    const registry = createSharedAgentRegistry({ configPath });

    await expect(registry.resolve("unknown")).resolves.toBeNull();
  });

  test("getConfigPath returns the resolved path", () => {
    const configPath = join(tmpDir, "registry.json");
    const registry = createSharedAgentRegistry({ configPath });

    expect(registry.getConfigPath()).toBe(configPath);
  });
});
