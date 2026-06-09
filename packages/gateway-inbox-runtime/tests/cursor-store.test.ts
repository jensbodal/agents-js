import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCursorStore } from "../src/cursor-store.ts";

describe("FileCursorStore", () => {
  test("round-trips seen keys and creates parent directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "gateway-cursor-"));
    try {
      const path = join(dir, "nested", "cursor.json");
      const store = new FileCursorStore(path);

      expect(store.load()).toEqual({ seen: [] });
      store.save({ seen: ["m1", "m2"] });

      expect(new FileCursorStore(path).load()).toEqual({ seen: ["m1", "m2"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("filters bad entries and tolerates corrupt files", () => {
    const dir = mkdtempSync(join(tmpdir(), "gateway-cursor-"));
    try {
      const path = join(dir, "cursor.json");
      writeFileSync(path, JSON.stringify({ seen: ["m1", 7, null, "m2"] }), "utf8");
      expect(new FileCursorStore(path).load()).toEqual({ seen: ["m1", "m2"] });

      writeFileSync(path, "{not json", "utf8");
      expect(new FileCursorStore(path).load()).toEqual({ seen: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
