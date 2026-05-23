/**
 * JCS (RFC 8785) encoder — behavior tests.
 *
 * These tests pin the canonical-encoding contract that AJS-55 peer
 * records and challenge-mint payloads depend on. Without
 * byte-identical canonicalization between signer and verifier, a
 * signature collected over `{"a":1,"b":2}` would not validate against
 * the verifier's recomputation over `{"b":2,"a":1}` — false-rejects
 * on semantically-equivalent records.
 *
 * Fixtures pulled from the RFC's worked examples + AJS-55 design
 * doc's expected shapes. Adding new tests when JCS edge-cases hit
 * real AJS-55 data is encouraged; the simple-path coverage here
 * proves the contract for what's actually serialized today.
 */

import { describe, expect, test } from "bun:test";
import { jcs } from "../src/jcs.ts";

describe("packages/host/tests/jcs.test.ts — RFC 8785 canonical JSON", () => {
  /**
   * WHAT: Primitives serialize to RFC 8785 lexical forms.
   * WHY: Without primitive correctness, nothing else in the encoder
   *      can be trusted. Pins the leaf cases.
   */
  test("primitives: null / boolean / integer / string", () => {
    expect(jcs(null)).toBe("null");
    expect(jcs(true)).toBe("true");
    expect(jcs(false)).toBe("false");
    expect(jcs(0)).toBe("0");
    expect(jcs(-0)).toBe("0"); // RFC 8785: -0 → "0"
    expect(jcs(42)).toBe("42");
    expect(jcs(-7)).toBe("-7");
    expect(jcs("hello")).toBe('"hello"');
    expect(jcs("")).toBe('""');
  });

  /**
   * WHAT: Object keys are sorted by UTF-16 code-unit value.
   * WHY: The keystone of canonical encoding. RFC 8785 §3.2.3
   *      mandates code-unit ordering, which is what JavaScript's
   *      default String comparison gives us for the BMP. Two
   *      semantically-identical objects with different key orders
   *      MUST serialize to the same byte sequence — otherwise the
   *      whole signature-over-canonical-form approach fails.
   */
  test("object keys sorted lexicographically (UTF-16 code-unit order)", () => {
    expect(jcs({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(jcs({ z: 1, a: 2, m: 3 })).toBe('{"a":2,"m":3,"z":1}');
    // Same input shape with reordered keys produces identical output:
    const order1 = jcs({ entity: "x", pubkey: "y", signed_at: "z" });
    const order2 = jcs({ signed_at: "z", entity: "x", pubkey: "y" });
    expect(order1).toBe(order2);
  });

  /**
   * WHAT: Arrays preserve input order; nested values are recursively
   *       canonicalized.
   * WHY: Array order is semantically meaningful in JSON; canonical
   *      encoding preserves it. Nested-recursive call site pinned so
   *      a regression that only canonicalizes the top level is
   *      caught.
   */
  test("arrays preserve order; nested values recursed", () => {
    expect(jcs([1, 2, 3])).toBe("[1,2,3]");
    expect(jcs(["b", "a"])).toBe('["b","a"]');
    expect(
      jcs([
        { b: 1, a: 2 },
        { d: 3, c: 4 },
      ]),
    ).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
  });

  /**
   * WHAT: Standard short-escape characters use the JSON short forms
   *       (`\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`). Other control
   *       chars use `\u00XX` lowercase hex.
   * WHY: RFC 8785 §3.2.2.2 specifies these escapes exactly. A
   *      regression to using `\t` literally (or vice versa) would
   *      produce byte-different but value-equivalent output, breaking
   *      signature verification.
   */
  test("string escapes: short forms for common control chars; \\u00XX for others", () => {
    expect(jcs('"')).toBe('"\\""');
    expect(jcs("\\")).toBe('"\\\\"');
    expect(jcs("\b")).toBe('"\\b"');
    expect(jcs("\f")).toBe('"\\f"');
    expect(jcs("\n")).toBe('"\\n"');
    expect(jcs("\r")).toBe('"\\r"');
    expect(jcs("\t")).toBe('"\\t"');
    // U+0001 has no short escape → 
    expect(jcs("\x01")).toBe('"\\u0001"');
    // U+001F is the boundary — last control char that needs escaping
    expect(jcs("\x1f")).toBe('"\\u001f"');
  });

  /**
   * WHAT: Forward slash `/` is NOT escaped (RFC 8785 explicitly
   *       forbids `\/`). Characters above U+007F pass through as-is
   *       (UTF-8 encoding happens at the byte-output step, not in the
   *       string form).
   * WHY: A regression that escaped `/` (some JSON.stringify variants
   *      do this) would produce non-canonical output. Same for
   *      over-escaping non-ASCII. Pin both negatively (assert NO
   *      escape) to catch the "too-defensive escape" anti-fix.
   */
  test("forward slash NOT escaped; non-ASCII passed through verbatim", () => {
    expect(jcs("a/b/c")).toBe('"a/b/c"');
    expect(jcs("café")).toBe('"café"');
    expect(jcs("é")).toBe('"é"'); // U+00E9 LATIN SMALL LETTER E WITH ACUTE
    expect(jcs("中文")).toBe('"中文"'); // BMP chars
  });

  /**
   * WHAT: AJS-55 peer record shape (the actual production payload)
   *       canonicalizes deterministically.
   * WHY: End-to-end pin for the real signed payload. If this test
   *      ever fails after a refactor, the entire peer-record signing
   *      contract breaks — no peer record signed under the old
   *      encoding verifies under the new one. Two-axis pin:
   *      key-order independence AND nested-value canonicalization.
   */
  test("AJS-55 peer record canonicalizes deterministically", () => {
    const record = {
      entity: "codex-hostname-null",
      pubkey: "base64-encoded-pubkey-here",
      capabilities: {
        scopes: ["matrix.send_message", "matrix.read", "inbox.deliver"],
        matrix: { room: "!cog:matrix.example" },
      },
      signed_at: "2026-05-22T18:00:00Z",
      signer: "fleet-root",
    };
    const reordered = {
      signer: "fleet-root",
      signed_at: "2026-05-22T18:00:00Z",
      capabilities: {
        matrix: { room: "!cog:matrix.example" },
        scopes: ["matrix.send_message", "matrix.read", "inbox.deliver"],
      },
      pubkey: "base64-encoded-pubkey-here",
      entity: "codex-hostname-null",
    };
    expect(jcs(record)).toBe(jcs(reordered));
    // Spot-check the actual canonical bytes start with the sorted-by-
    // top-key shape: capabilities < entity < pubkey < signed_at < signer
    expect(jcs(record).startsWith('{"capabilities":{')).toBe(true);
  });

  /**
   * WHAT: NaN / Infinity / -Infinity throw — they're not JSON values.
   * WHY: Defense against the caller-passes-garbage path. JSON.stringify
   *      silently emits `null` for these; for cryptographic
   *      canonicalization, silently substituting null would produce a
   *      signature over `null` while the caller thought they signed
   *      a number. Fail loudly.
   */
  test("non-finite numbers throw (not silently nullified)", () => {
    expect(() => jcs(Number.NaN)).toThrow(/non-finite/);
    expect(() => jcs(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => jcs(Number.NEGATIVE_INFINITY)).toThrow(/non-finite/);
  });

  /**
   * WHAT: `undefined` throws (not representable in JSON).
   * WHY: Same defense-loudly principle. JSON.stringify drops undefined
   *      from objects + arrays silently; canonical encoding for
   *      signing MUST NOT silently drop fields the caller might be
   *      assuming get signed.
   */
  test("undefined throws (not silently dropped)", () => {
    expect(() => jcs(undefined)).toThrow(/undefined/);
  });
});
