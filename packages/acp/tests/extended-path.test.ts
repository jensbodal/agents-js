import { describe, expect, test } from "bun:test";
import { mergeBinPaths } from "../src/extended-path.ts";

describe("mergeBinPaths", () => {
  test("returns the base path unchanged when no extras are given", () => {
    expect(mergeBinPaths("/usr/bin:/bin")).toBe("/usr/bin:/bin");
  });

  test("appends extra bin paths after the base, preserving order", () => {
    expect(mergeBinPaths("/usr/bin", ["/opt/a/bin", "/opt/b/bin"])).toBe(
      "/usr/bin:/opt/a/bin:/opt/b/bin",
    );
  });

  test("de-duplicates while keeping first-seen position", () => {
    expect(mergeBinPaths("/usr/bin:/bin", ["/usr/bin", "/opt/x"])).toBe("/usr/bin:/bin:/opt/x");
  });

  test("drops empty segments from the base and the extras", () => {
    expect(mergeBinPaths("/usr/bin::/bin", ["", "/opt/x", ""])).toBe("/usr/bin:/bin:/opt/x");
  });

  test("handles undefined/empty base path", () => {
    expect(mergeBinPaths(undefined, ["/opt/x"])).toBe("/opt/x");
    expect(mergeBinPaths("", ["/opt/x"])).toBe("/opt/x");
    expect(mergeBinPaths(undefined)).toBe("");
  });
});
