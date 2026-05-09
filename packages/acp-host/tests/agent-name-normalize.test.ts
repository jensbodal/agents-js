import { describe, expect, test } from "bun:test";
import { normalizeAgentName } from "../src/agent-name-normalize.ts";

describe("normalizeAgentName — minimum viable proof-of-concept", () => {
  test("strips zero-width space prefix (today's actual bug)", () => {
    const result = normalizeAgentName("\u200bSisyphus - Ultraworker");
    expect(result.name).toBe("Sisyphus - Ultraworker");
    expect(result.normalized).toBe(true);
    expect(result.original).toBe("\u200bSisyphus - Ultraworker");
  });

  test("passes clean names through unchanged", () => {
    const result = normalizeAgentName("Sisyphus - Ultraworker");
    expect(result.name).toBe("Sisyphus - Ultraworker");
    expect(result.normalized).toBe(false);
  });

  test("preserves legitimate name shapes — emoji, international letters, punctuation, case", () => {
    // Each exercises a different kind of legitimate content the normalizer
    // must pass through unchanged. Pure fixture data — none of these are
    // real agent references anywhere in the codebase.
    for (const legit of [
      "🤖 Helper", // emoji + space
      "設計士", // CJK
      "Sisyphus (Ultraworker)", // parens + mixed case + space + dash not present
      "my-dev-agent", // lowercase + hyphens (happens to already be slug-shape)
    ]) {
      const result = normalizeAgentName(legit);
      expect(result.name).toBe(legit);
      expect(result.normalized).toBe(false);
    }
  });
});
