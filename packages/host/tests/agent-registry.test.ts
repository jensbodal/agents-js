import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRegistryFromDisk } from "../src/agent-registry.ts";

// loadRegistryFromDisk is the gateway-startup hook that resolves @mention
// names to A2A URLs / ACP harness specs. The contract documented in the
// source is: silent fallback to empty map on any read/parse error, drop
// malformed entries individually, normalize ZWSP/default-ignorable name
// chars on ingress.

function writeRegistry(dir: string, body: unknown): string {
  const filePath = path.join(dir, "registry.json");
  writeFileSync(filePath, JSON.stringify(body));
  return filePath;
}

let tmpRoot: string;
const originalEnv = process.env.AGENTS_JS_REGISTRY;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "host-registry-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (originalEnv === undefined) {
    delete process.env.AGENTS_JS_REGISTRY;
  } else {
    process.env.AGENTS_JS_REGISTRY = originalEnv;
  }
});

describe("loadRegistryFromDisk — silent fallback", () => {
  test("returns {} when the registry file does not exist", () => {
    process.env.AGENTS_JS_REGISTRY = path.join(tmpRoot, "missing.json");
    expect(loadRegistryFromDisk()).toEqual({});
  });

  test("returns {} when the registry file is unparseable JSON", () => {
    const filePath = path.join(tmpRoot, "garbage.json");
    writeFileSync(filePath, "{not json");
    process.env.AGENTS_JS_REGISTRY = filePath;
    expect(loadRegistryFromDisk()).toEqual({});
  });

  test("returns {} when the file exists but has no agents key", () => {
    process.env.AGENTS_JS_REGISTRY = writeRegistry(tmpRoot, { other: 1 });
    expect(loadRegistryFromDisk()).toEqual({});
  });
});

describe("loadRegistryFromDisk — entry shape", () => {
  test("default kind is a2a; requires url", () => {
    process.env.AGENTS_JS_REGISTRY = writeRegistry(tmpRoot, {
      agents: {
        good: { url: "http://127.0.0.1:9000" },
        missingUrl: { not: "url" },
        emptyUrl: { url: "" },
      },
    });
    const map = loadRegistryFromDisk();
    expect(map.good).toEqual({ kind: "a2a", name: "good", url: "http://127.0.0.1:9000" });
    expect(map.missingUrl).toBeUndefined();
    expect(map.emptyUrl).toBeUndefined();
  });

  test("kind=acp requires harness; optional fields included only when well-typed", () => {
    process.env.AGENTS_JS_REGISTRY = writeRegistry(tmpRoot, {
      agents: {
        full: {
          kind: "acp",
          harness: "claude",
          command: "/usr/local/bin/claude",
          args: ["--flag"],
          env: { FOO: "bar" },
          workspaceFlag: "--cwd",
        },
        minimal: { kind: "acp", harness: "codex" },
        missingHarness: { kind: "acp" },
        emptyHarness: { kind: "acp", harness: "  " },
        badArgs: { kind: "acp", harness: "x", args: [1, 2] },
        badEnv: { kind: "acp", harness: "y", env: { ok: "s", bad: 42 } },
      },
    });
    const map = loadRegistryFromDisk();
    expect(map.full).toEqual({
      kind: "acp",
      name: "full",
      harness: "claude",
      command: "/usr/local/bin/claude",
      args: ["--flag"],
      env: { FOO: "bar" },
      workspaceFlag: "--cwd",
    });
    // minimal: only required field; no command/args/env
    expect(map.minimal).toEqual({ kind: "acp", name: "minimal", harness: "codex" });
    expect(map.missingHarness).toBeUndefined();
    expect(map.emptyHarness).toBeUndefined();
    // malformed optional fields drop silently — required fields preserved
    expect(map.badArgs).toEqual({ kind: "acp", name: "badArgs", harness: "x" });
    expect(map.badEnv).toEqual({ kind: "acp", name: "badEnv", harness: "y" });
  });

  test("strips zero-width / default-ignorable characters from names", () => {
    // ZERO WIDTH SPACE U+200B inside the key
    const tainted = "agent​name";
    process.env.AGENTS_JS_REGISTRY = writeRegistry(tmpRoot, {
      agents: { [tainted]: { url: "http://example.test" } },
    });
    const map = loadRegistryFromDisk();
    expect(map.agentname).toBeDefined();
    expect(map[tainted]).toBeUndefined();
  });
});
