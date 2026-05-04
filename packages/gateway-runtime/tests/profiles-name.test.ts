import { describe, expect, test } from "bun:test";
import { validateRuntimeProfileName } from "../src/profiles/name.ts";

describe("validateRuntimeProfileName", () => {
  test("accepts lowercase letters, digits, underscore, and hyphen", () => {
    expect(validateRuntimeProfileName("clean-room")).toBe("clean-room");
    expect(validateRuntimeProfileName("my_profile_42")).toBe("my_profile_42");
    expect(validateRuntimeProfileName("a")).toBe("a");
  });

  test("trims surrounding whitespace before validating", () => {
    expect(validateRuntimeProfileName("  clean-room  ")).toBe("clean-room");
  });

  test("rejects uppercase letters", () => {
    expect(() => validateRuntimeProfileName("CleanRoom")).toThrow(
      'Profile names must contain only lowercase letters, numbers, "_" or "-".',
    );
    // Error message must include the offending value so standalone callers
    // can surface it without re-wrapping.
    expect(() => validateRuntimeProfileName("CleanRoom")).toThrow('"CleanRoom"');
  });

  test("rejects spaces inside the name", () => {
    expect(() => validateRuntimeProfileName("Bad Name")).toThrow(
      'Profile names must contain only lowercase letters, numbers, "_" or "-".',
    );
    expect(() => validateRuntimeProfileName("Bad Name")).toThrow('"Bad Name"');
  });

  test("rejects empty string after trim", () => {
    expect(() => validateRuntimeProfileName("   ")).toThrow(
      'Profile names must contain only lowercase letters, numbers, "_" or "-".',
    );
  });

  test("rejects path separators", () => {
    expect(() => validateRuntimeProfileName("a/b")).toThrow();
    expect(() => validateRuntimeProfileName("a\\b")).toThrow();
  });

  test("rejects shell metacharacters", () => {
    expect(() => validateRuntimeProfileName("a;b")).toThrow();
    expect(() => validateRuntimeProfileName("a$b")).toThrow();
  });
});
