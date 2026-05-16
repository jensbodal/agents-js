import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const NODE_ONLY_PATTERNS = [
  /from\s+["']node:/,
  /from\s+["']fs["']/,
  /from\s+["']path["']/,
  /from\s+["']child_process["']/,
  /from\s+["']os["']/,
  /from\s+["']crypto["']/,
  /from\s+["']buffer["']/,
  /from\s+["']stream["']/,
  /from\s+["']events["']/,
  /from\s+["']util["']/,
  /from\s+["']worker_threads["']/,
];

const MAIN_ENTRY_FILES = ["index.ts", "types.ts", "provider.ts"];

describe("@agents-js/memory — main entry browser-safe", () => {
  it("the main entry import graph references no Node-only modules", async () => {
    const violations: { file: string; pattern: string }[] = [];
    for (const file of MAIN_ENTRY_FILES) {
      const text = await readFile(join(SRC_DIR, file), "utf8");
      for (const pattern of NODE_ONLY_PATTERNS) {
        if (pattern.test(text)) {
          violations.push({ file, pattern: pattern.source });
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("conformance helpers are isolated to the testing subpath (not main)", async () => {
    const indexText = await readFile(join(SRC_DIR, "index.ts"), "utf8");
    expect(indexText.includes("InMemoryProvider")).toBe(false);
    expect(indexText.includes("runProviderConformanceTests")).toBe(false);
  });

  it("src/ has no unexpected files (drift guard)", async () => {
    const expected = new Set([
      "index.ts",
      "types.ts",
      "provider.ts",
      "testing.ts",
      "conformance.ts",
      "in-memory-provider.ts",
    ]);
    const found = new Set(await readdir(SRC_DIR));
    expect([...found].sort()).toEqual([...expected].sort());
  });
});
