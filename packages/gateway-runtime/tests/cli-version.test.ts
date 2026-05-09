import { describe, expect, test } from "bun:test";
import { getCliVersion } from "../src/cli-version.ts";

describe("getCliVersion", () => {
  test("returns the version string when present", () => {
    expect(getCliVersion({ version: "1.2.3" })).toBe("1.2.3");
  });

  test("returns the version string for the train invariant shape", () => {
    expect(getCliVersion({ version: "0.2.0-beta-3" })).toBe("0.2.0-beta-3");
  });

  test("ignores other fields on the pkg object", () => {
    expect(
      getCliVersion({
        version: "9.9.9",
        name: "@agents-js/example",
        dependencies: { foo: "1.0.0" },
      } as { version?: unknown }),
    ).toBe("9.9.9");
  });

  test("throws when version is missing", () => {
    expect(() => getCliVersion({})).toThrow(/missing a non-empty string 'version'/);
  });

  test("throws when version is not a string", () => {
    expect(() => getCliVersion({ version: 123 })).toThrow(/missing a non-empty string 'version'/);
  });

  test("throws when version is an empty string", () => {
    expect(() => getCliVersion({ version: "" })).toThrow(/missing a non-empty string 'version'/);
  });
});
