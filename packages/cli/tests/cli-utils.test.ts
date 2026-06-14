import { describe, expect, test } from "bun:test";
import { parseNonNegativeInteger } from "../src/cli-utils.ts";

describe("parseNonNegativeInteger", () => {
  test("parses a plain non-negative integer", () => {
    expect(parseNonNegativeInteger("5000", "AGENTS_JS_SYNC_INTERVAL_MS")).toBe(5000);
  });

  test("accepts zero", () => {
    expect(parseNonNegativeInteger("0", "AGENTS_JS_SYNC_INTERVAL_MS")).toBe(0);
  });

  test("trims surrounding whitespace", () => {
    expect(parseNonNegativeInteger("  100  ", "AGENTS_JS_SYNC_INTERVAL_MS")).toBe(100);
  });

  test("rejects a non-numeric string", () => {
    expect(() => parseNonNegativeInteger("abc", "AGENTS_JS_SYNC_INTERVAL_MS")).toThrow();
  });

  test("rejects a negative value", () => {
    expect(() => parseNonNegativeInteger("-5", "AGENTS_JS_SYNC_INTERVAL_MS")).toThrow();
  });

  test("rejects a decimal", () => {
    expect(() => parseNonNegativeInteger("1.5", "AGENTS_JS_SYNC_INTERVAL_MS")).toThrow();
  });

  test("rejects scientific notation (NaN/Infinity sources)", () => {
    expect(() => parseNonNegativeInteger("1e999", "AGENTS_JS_SYNC_INTERVAL_MS")).toThrow();
    expect(() => parseNonNegativeInteger("Infinity", "AGENTS_JS_SYNC_INTERVAL_MS")).toThrow();
  });

  test("rejects an unsafe (too-large) integer", () => {
    expect(() =>
      parseNonNegativeInteger("99999999999999999999", "AGENTS_JS_SYNC_INTERVAL_MS"),
    ).toThrow();
  });

  test("includes the label and offending value in the error message", () => {
    expect(() => parseNonNegativeInteger("nope", "AGENTS_JS_SYNC_INTERVAL_MS")).toThrow(
      /AGENTS_JS_SYNC_INTERVAL_MS.*nope/,
    );
  });
});
