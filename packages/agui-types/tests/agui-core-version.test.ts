import { describe, expect, test } from "bun:test";
import { AGUI_CORE_VERSION } from "@agents-js/agui-types";

describe("AGUI_CORE_VERSION", () => {
  test("is a non-empty string", () => {
    expect(typeof AGUI_CORE_VERSION).toBe("string");
    expect(AGUI_CORE_VERSION.length).toBeGreaterThan(0);
  });

  test("matches a semver shape (MAJOR.MINOR.PATCH)", () => {
    expect(AGUI_CORE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
