import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeConfigFromRegistry } from "../src/registry-adapter.ts";

function withTempDir(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-bridge-test-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("bridgeConfigFromRegistry", () => {
  test(
    "returns agents from a valid registry file",
    withTempDir(async (dir) => {
      const registryPath = join(dir, "registry.json");
      writeFileSync(
        registryPath,
        JSON.stringify({
          agents: {
            "code-reviewer": { url: "http://localhost:3001" },
            summarizer: { url: "http://localhost:3002" },
          },
        }),
      );

      const config = await bridgeConfigFromRegistry(registryPath);
      expect(config.agents).toHaveLength(2);
      expect(config.agents).toContainEqual({
        name: "code-reviewer",
        url: "http://localhost:3001",
      });
      expect(config.agents).toContainEqual({
        name: "summarizer",
        url: "http://localhost:3002",
      });
    }),
  );

  test(
    "returns empty agents when file does not exist",
    withTempDir(async (dir) => {
      const config = await bridgeConfigFromRegistry(join(dir, "nonexistent.json"));
      expect(config.agents).toEqual([]);
    }),
  );

  test(
    "returns empty agents when file contains invalid JSON",
    withTempDir(async (dir) => {
      const registryPath = join(dir, "registry.json");
      writeFileSync(registryPath, "not valid json {{{");

      const config = await bridgeConfigFromRegistry(registryPath);
      expect(config.agents).toEqual([]);
    }),
  );

  test(
    "returns empty agents when file has no agents key",
    withTempDir(async (dir) => {
      const registryPath = join(dir, "registry.json");
      writeFileSync(registryPath, JSON.stringify({ version: 1 }));

      const config = await bridgeConfigFromRegistry(registryPath);
      expect(config.agents).toEqual([]);
    }),
  );

  test(
    "returns empty agents when agents object is empty",
    withTempDir(async (dir) => {
      const registryPath = join(dir, "registry.json");
      writeFileSync(registryPath, JSON.stringify({ agents: {} }));

      const config = await bridgeConfigFromRegistry(registryPath);
      expect(config.agents).toEqual([]);
    }),
  );

  test(
    "returns empty agents when the shared registry contains malformed entries",
    withTempDir(async (dir) => {
      const registryPath = join(dir, "registry.json");
      writeFileSync(
        registryPath,
        JSON.stringify({
          agents: {
            "valid-agent": { url: "http://localhost:3001" },
            "bad-entry": "not an object",
            "missing-url": { name: "oops" },
          },
        }),
      );

      const config = await bridgeConfigFromRegistry(registryPath);
      expect(config.agents).toEqual([]);
    }),
  );
});
