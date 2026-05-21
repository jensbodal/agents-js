import { describe, expect, test } from "bun:test";
import { normalizePermissionMode } from "../src/session-state.ts";

describe("normalizePermissionMode", () => {
  test("canonical strings pass through unchanged", () => {
    expect(normalizePermissionMode("default")).toBe("default");
    expect(normalizePermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(normalizePermissionMode("plan")).toBe("plan");
    expect(normalizePermissionMode("bypassPermissions")).toBe("bypassPermissions");
  });

  test("legacy strings map to canonical (back-compat)", () => {
    expect(normalizePermissionMode("ask")).toBe("default");
    expect(normalizePermissionMode("yolo")).toBe("bypassPermissions");
    // `hub` was functionally identical to `ask` in the legacy permission
    // pipeline (session-permissions.ts:88-137 treated ask/plan/hub the same).
    // Folder-scoped auto-approve is independent — driven by hubPath via the
    // write-gate path check, not the mode flag — so `hub` normalizes to
    // `default` without losing the hub-routing capability.
    expect(normalizePermissionMode("hub")).toBe("default");
    expect(normalizePermissionMode("plan")).toBe("plan");
  });

  test("unknown strings fall back to default", () => {
    expect(normalizePermissionMode("nonsense" as never)).toBe("default");
    expect(normalizePermissionMode("" as never)).toBe("default");
  });
});
