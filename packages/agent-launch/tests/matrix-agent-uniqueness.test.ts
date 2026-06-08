/**
 * Tests for write-time MATRIX_AGENT uniqueness (#37 / ADR #75 Phase 1).
 * Locks the permissive extractor + the reject-co-claimants / continue-non-
 * colliders contract over the lazy-normalized raw entry set.
 */
import { describe, expect, test } from "bun:test";
import type { LaunchConfig } from "../src/config.ts";
import {
  assertSelectedMatrixAgentUnique,
  extractMatrixAgent,
  MatrixAgentCollisionError,
} from "../src/matrix-agent-uniqueness.ts";

/** Build a LaunchConfig from raw agent entries (mirrors lazy-normalized shape). */
function config(agents: Record<string, unknown>): LaunchConfig {
  return { version: "0.1.0", agents };
}

/** Raw entry with an `export MATRIX_AGENT=<name>` env_setup. */
function entry(matrixAgent: string | undefined, tmuxSession: string): Record<string, unknown> {
  return {
    tmux_session: tmuxSession,
    harness: "claude-code",
    binary: "claude",
    workspace: "/tmp",
    fresh_flags: "",
    ...(matrixAgent !== undefined ? { env_setup: `export MATRIX_AGENT=${matrixAgent}` } : {}),
  };
}

describe("extractMatrixAgent", () => {
  test("extracts a simple export value", () => {
    expect(extractMatrixAgent("export MATRIX_AGENT=ajs-claude")).toBe("ajs-claude");
  });

  test("strips matching double and single quotes", () => {
    expect(extractMatrixAgent('export MATRIX_AGENT="quoted"')).toBe("quoted");
    expect(extractMatrixAgent("export MATRIX_AGENT='single'")).toBe("single");
  });

  test("finds MATRIX_AGENT among other exports (multi-segment)", () => {
    expect(
      extractMatrixAgent("export MATRIX_HOMESERVER=https://h && export MATRIX_AGENT=foo"),
    ).toBe("foo");
    expect(extractMatrixAgent("export A=1\nexport MATRIX_AGENT=bar\nexport B=2")).toBe("bar");
  });

  test("returns undefined for absent env_setup or no MATRIX_AGENT", () => {
    expect(extractMatrixAgent(undefined)).toBeUndefined();
    expect(extractMatrixAgent("export OTHER=1")).toBeUndefined();
    expect(extractMatrixAgent("")).toBeUndefined();
  });

  test("returns undefined for empty value", () => {
    expect(extractMatrixAgent("export MATRIX_AGENT=")).toBeUndefined();
  });

  test("returns undefined (never throws) for shell expansion / command substitution", () => {
    expect(extractMatrixAgent("export MATRIX_AGENT=$(hostname)")).toBeUndefined();
    expect(extractMatrixAgent("export MATRIX_AGENT=`hostname`")).toBeUndefined();
    expect(extractMatrixAgent("export MATRIX_AGENT=$NAME")).toBeUndefined();
  });

  test("is robust to a sibling complex export (does not abort the scan)", () => {
    // Other line uses command-subst, but MATRIX_AGENT is a clean literal — the
    // permissive scan still recovers it rather than throwing on the sibling.
    expect(extractMatrixAgent("export X=$(echo hi) && export MATRIX_AGENT=clean")).toBe("clean");
  });
});

describe("assertSelectedMatrixAgentUnique", () => {
  test("passes when the selected agent's MATRIX_AGENT is unique", () => {
    const cfg = config({ a: entry("alpha", "a"), b: entry("beta", "b") });
    expect(() => assertSelectedMatrixAgentUnique(cfg, "a")).not.toThrow();
  });

  test("passes when the selected agent declares no MATRIX_AGENT", () => {
    const cfg = config({ a: entry(undefined, "a"), b: entry("beta", "b") });
    expect(() => assertSelectedMatrixAgentUnique(cfg, "a")).not.toThrow();
  });

  test("throws when the selected agent is one of two equal co-claimants", () => {
    const cfg = config({ a: entry("dup", "sess-a"), b: entry("dup", "sess-b") });
    expect(() => assertSelectedMatrixAgentUnique(cfg, "a")).toThrow(MatrixAgentCollisionError);
  });

  test("error names the MATRIX_AGENT and every conflicting tmuxSession", () => {
    const cfg = config({ a: entry("dup", "sess-a"), b: entry("dup", "sess-b") });
    try {
      assertSelectedMatrixAgentUnique(cfg, "a");
      throw new Error("expected a collision");
    } catch (err) {
      expect(err).toBeInstanceOf(MatrixAgentCollisionError);
      const e = err as MatrixAgentCollisionError;
      expect(e.matrixAgent).toBe("dup");
      expect(e.claimants.map((c) => c.tmuxSession).sort()).toEqual(["sess-a", "sess-b"]);
      expect(e.message).toContain("dup");
      expect(e.message).toContain("sess-a");
      expect(e.message).toContain("sess-b");
    }
  });

  test("reports all three claimants on a 3-way collision", () => {
    const cfg = config({
      a: entry("dup", "sess-a"),
      b: entry("dup", "sess-b"),
      c: entry("dup", "sess-c"),
    });
    try {
      assertSelectedMatrixAgentUnique(cfg, "b");
      throw new Error("expected a collision");
    } catch (err) {
      const e = err as MatrixAgentCollisionError;
      expect(e.claimants).toHaveLength(3);
      expect(e.claimants.map((c) => c.tmuxSession)).toEqual(["sess-a", "sess-b", "sess-c"]);
    }
  });

  test("a clean selected agent is NOT blocked by an unrelated dup among others", () => {
    // b + c collide on "dup", but the selected agent a is unique → launch proceeds.
    const cfg = config({
      a: entry("alpha", "a"),
      b: entry("dup", "sess-b"),
      c: entry("dup", "sess-c"),
    });
    expect(() => assertSelectedMatrixAgentUnique(cfg, "a")).not.toThrow();
  });

  test("falls back to the config key when a co-claimant lacks tmux_session", () => {
    const cfg = config({
      a: { env_setup: "export MATRIX_AGENT=dup" }, // no tmux_session
      b: entry("dup", "sess-b"),
    });
    try {
      assertSelectedMatrixAgentUnique(cfg, "a");
      throw new Error("expected a collision");
    } catch (err) {
      const e = err as MatrixAgentCollisionError;
      expect(e.claimants.map((c) => c.tmuxSession).sort()).toEqual(["a", "sess-b"]);
    }
  });

  test("documented limitation: a shell-expanded MATRIX_AGENT is not a detectable claimant", () => {
    // Selected is a clean literal; the other entry's MATRIX_AGENT is command-
    // substituted, so it can't be statically resolved → no Phase-1 collision.
    const cfg = config({
      a: entry("foo", "a"),
      b: { tmux_session: "b", env_setup: "export MATRIX_AGENT=$(echo foo)" },
    });
    expect(() => assertSelectedMatrixAgentUnique(cfg, "a")).not.toThrow();
  });
});
