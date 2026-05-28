import { describe, expect, test } from "bun:test";
import { sanitizeMetaForChannel } from "../src/meta-sanitizer.ts";

describe("sanitizeMetaForChannel", () => {
  test("clean identifier-shaped keys pass through unchanged", () => {
    const result = sanitizeMetaForChannel({
      source: "matrix",
      sender: "@ajs-claude:matrix",
      idempotency_key: "abc-123",
      retry_count: 0,
    });
    expect(result).toEqual({
      source: "matrix",
      sender: "@ajs-claude:matrix",
      idempotency_key: "abc-123",
      retry_count: 0,
    });
  });

  test("rejects hyphenated keys by default (Claude Code silently drops them)", () => {
    expect(() => sanitizeMetaForChannel({ "matrix-origin": "room-id" })).toThrow(
      /meta key "matrix-origin" is not an identifier/,
    );
  });

  test("autoRewrite converts hyphens to underscores", () => {
    const result = sanitizeMetaForChannel(
      { "matrix-origin": "room-id", clean_key: 42 },
      { autoRewrite: true },
    );
    expect(result).toEqual({ matrix_origin: "room-id", clean_key: 42 });
  });

  test("autoRewrite throws on collision when two source keys collapse to the same target (hyphen-first ordering)", () => {
    // Iteration order: "x-y" (rewritten to x_y) lands first, then x_y
    // (identifier-shape) collides. The identifier-path collision message
    // fires because the rewritten entry is already in `out`.
    expect(() =>
      sanitizeMetaForChannel({ "x-y": "first", x_y: "second" }, { autoRewrite: true }),
    ).toThrow(/collides with an auto-rewritten key/);
  });

  test("autoRewrite throws on collision (identifier-first ordering)", () => {
    // Iteration order: x_y first, then "x-y" tries to rewrite onto an
    // existing identifier-shaped key. The rewrite-path collision message
    // fires because the identifier entry is already in `out`.
    expect(() =>
      sanitizeMetaForChannel({ x_y: "first", "x-y": "second" }, { autoRewrite: true }),
    ).toThrow(/auto-rewrites to "x_y" which collides with an existing key/);
  });

  test("autoRewrite still rejects keys with non-hyphen non-identifier chars", () => {
    expect(() => sanitizeMetaForChannel({ "has.dot": "v" }, { autoRewrite: true })).toThrow(
      /cannot be rewritten to an identifier/,
    );
  });

  test("rejects keys that start with a digit (not a valid identifier)", () => {
    expect(() => sanitizeMetaForChannel({ "1key": "v" })).toThrow(/not an identifier/);
  });

  test("empty input returns empty sanitized payload", () => {
    expect(sanitizeMetaForChannel({})).toEqual({});
  });
});
