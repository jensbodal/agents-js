import { describe, expect, test } from "bun:test";
import { normalizePermissionMode } from "../src/session-state.ts";

describe("normalizePermissionMode", () => {
  test("canonical strings pass through unchanged", () => {
    expect(normalizePermissionMode("default")).toBe("default");
    expect(normalizePermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(normalizePermissionMode("plan")).toBe("plan");
    expect(normalizePermissionMode("bypassPermissions")).toBe("bypassPermissions");
  });

  test("unknown strings fall back to default", () => {
    expect(normalizePermissionMode("nonsense" as never)).toBe("default");
    expect(normalizePermissionMode("" as never)).toBe("default");
  });
});
