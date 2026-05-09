import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { SessionIdStore } from "../src/persistence.ts";

describe("SessionIdStore", () => {
  const testDir = join(process.cwd(), "tmp", "test-persistence");
  const dotDir = join(testDir, "_dot");

  beforeAll(async () => {
    await mkdir(dotDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("save and load a session map", async () => {
    const store = new SessionIdStore(testDir);
    const map = new Map([
      ["ctx-1", "sess-1"],
      ["ctx-2", "sess-2"],
    ]);

    await store.save(map);

    const loadedMap = await store.load();
    expect(loadedMap.get("ctx-1")).toBe("sess-1");
    expect(loadedMap.get("ctx-2")).toBe("sess-2");
    expect(loadedMap.size).toBe(2);
  });

  test("load returns empty map if file doesn't exist", async () => {
    const store = new SessionIdStore(join(testDir, "non-existent"));
    const map = await store.load();
    expect(map.size).toBe(0);
  });
});
