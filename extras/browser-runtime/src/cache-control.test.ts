import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { clearModelCache } from "./cache-control.ts";

const stash: { caches?: unknown } = {};

beforeEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: test stubs globalThis.caches
  stash.caches = (globalThis as any).caches;
});

afterEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: test stubs globalThis.caches
  (globalThis as any).caches = stash.caches;
});

describe("clearModelCache", () => {
  it("returns false when Cache API is unavailable", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test stubs globalThis.caches
    delete (globalThis as any).caches;
    expect(await clearModelCache()).toEqual({ cleared: false, reason: "no-cache-api" });
  });

  it("deletes all caches matching the webllm prefix", async () => {
    const deleted: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test stubs globalThis.caches
    (globalThis as any).caches = {
      keys: async () => ["webllm/Qwen", "webllm/Llama", "other"],
      delete: async (key: string) => {
        deleted.push(key);
        return true;
      },
    };
    const result = await clearModelCache();
    expect(result.cleared).toBe(true);
    expect(deleted.sort()).toEqual(["webllm/Llama", "webllm/Qwen"]);
  });
});
