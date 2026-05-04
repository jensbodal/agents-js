/**
 * Tests for the `randomUuid` helper. The fallback-path test deliberately
 * shadows `globalThis.crypto.randomUUID` so it exercises the code a
 * non-localhost HTTP browser would hit. Without this, the existing test
 * suite runs in Node where `randomUUID` is always present, and the
 * fallback regression would be invisible until the next deploy hits
 * a non-localhost origin.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { randomUuid } from "../src/uuid.ts";

describe("randomUuid", () => {
  // Cast through `unknown` to a shape where `randomUUID` is optional, so
  // `delete` is legal TypeScript. The lib.dom.d.ts `Crypto` type has
  // `randomUUID` marked required; for this test we need to treat it as
  // optional so we can delete + restore it.
  const cryptoRef = globalThis.crypto as unknown as { randomUUID?: () => string };
  const originalRandomUUID = cryptoRef.randomUUID;

  afterEach(() => {
    if (originalRandomUUID !== undefined) {
      cryptoRef.randomUUID = originalRandomUUID;
    }
  });

  test("returns a canonical RFC 4122 v4 UUID on the native path", () => {
    const uuid = randomUuid();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("falls back to crypto.getRandomValues when randomUUID is unavailable", () => {
    // Hide the native implementation to force the fallback path; this
    // mirrors how a plain-HTTP, non-localhost browser would see the
    // environment (randomUUID exists only in secure contexts; getRandomValues
    // is always available when Web Crypto is present).
    delete cryptoRef.randomUUID;

    const uuid = randomUuid();

    // Regex asserts BOTH the canonical 8-4-4-4-12 dash layout AND the
    // version/variant bits: `4[0-9a-f]{3}` pins byte 6 high nibble to
    // 4, `[89ab][0-9a-f]{3}` pins byte 8 top two bits to `10`. Any
    // off-by-one in the bit-twiddling fails this.
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("fallback produces distinct UUIDs across successive calls", () => {
    delete cryptoRef.randomUUID;
    const first = randomUuid();
    const second = randomUuid();
    expect(first).not.toBe(second);
  });
});
