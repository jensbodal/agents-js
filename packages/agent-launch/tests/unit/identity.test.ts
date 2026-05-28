/**
 * Tests for identity env composition. Phase 1: git + MATRIX_AGENT only.
 */
import { describe, expect, test } from "bun:test";
import type { AgentEntry } from "../../src/config.ts";
import { IdentityEnvError, injectIdentityEnv, parseEnvSetup } from "../../src/identity.ts";

function mkEntry(overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    tmuxSession: "test-agent",
    harness: "claude-code",
    binary: "claude",
    workspace: "/tmp",
    freshFlags: "--agent test-agent",
    extra: {},
    ...overrides,
  };
}

describe("parseEnvSetup", () => {
  test("simple export", () => {
    expect(parseEnvSetup("export FOO=bar")).toEqual({ FOO: "bar" });
  });

  test("double-quoted value", () => {
    expect(parseEnvSetup('export FOO="bar baz"')).toEqual({ FOO: "bar baz" });
  });

  test("single-quoted value", () => {
    expect(parseEnvSetup("export FOO='bar baz'")).toEqual({ FOO: "bar baz" });
  });

  test("multiple exports separated by newline", () => {
    expect(parseEnvSetup("export FOO=a\nexport BAR=b")).toEqual({ FOO: "a", BAR: "b" });
  });

  test("multiple exports separated by &&", () => {
    expect(parseEnvSetup("export FOO=a && export BAR=b")).toEqual({ FOO: "a", BAR: "b" });
  });

  test("empty input returns empty record", () => {
    expect(parseEnvSetup("")).toEqual({});
  });

  test("rejects command substitution $(...)", () => {
    expect(() => parseEnvSetup("export FOO=$(date)")).toThrow(IdentityEnvError);
  });

  test("rejects backtick substitution", () => {
    expect(() => parseEnvSetup("export FOO=`date`")).toThrow(IdentityEnvError);
  });

  test("rejects var expansion $VAR", () => {
    expect(() => parseEnvSetup("export FOO=$PATH")).toThrow(IdentityEnvError);
  });

  test("rejects non-export lines", () => {
    expect(() => parseEnvSetup("FOO=bar")).toThrow(IdentityEnvError);
  });

  test("rejects bad identifier key", () => {
    expect(() => parseEnvSetup("export 9FOO=bar")).toThrow(IdentityEnvError);
  });
});

describe("injectIdentityEnv — git identity", () => {
  test("full identity: all 4 git vars set", () => {
    const entry = mkEntry({
      gitAuthorName: "test-agent",
      gitAuthorEmail: "test@example",
    });
    const out = injectIdentityEnv(entry, { PATH: "/usr/bin" });
    expect(out.GIT_AUTHOR_NAME).toBe("test-agent");
    expect(out.GIT_AUTHOR_EMAIL).toBe("test@example");
    expect(out.GIT_COMMITTER_NAME).toBe("test-agent");
    expect(out.GIT_COMMITTER_EMAIL).toBe("test@example");
    expect(out.PATH).toBe("/usr/bin");
  });

  test("partial identity (name only) → no git vars set", () => {
    const entry = mkEntry({ gitAuthorName: "test-agent" });
    const out = injectIdentityEnv(entry, {});
    expect(out.GIT_AUTHOR_NAME).toBeUndefined();
    expect(out.GIT_COMMITTER_NAME).toBeUndefined();
  });

  test("partial identity (email only) → no git vars set", () => {
    const entry = mkEntry({ gitAuthorEmail: "test@example" });
    const out = injectIdentityEnv(entry, {});
    expect(out.GIT_AUTHOR_EMAIL).toBeUndefined();
    expect(out.GIT_COMMITTER_EMAIL).toBeUndefined();
  });

  test("no identity at all → baseEnv passes through unchanged", () => {
    const entry = mkEntry();
    const out = injectIdentityEnv(entry, { PATH: "/usr/bin", FOO: "bar" });
    expect(out).toEqual({ PATH: "/usr/bin", FOO: "bar" });
  });
});

describe("injectIdentityEnv — envSetup composition", () => {
  test("MATRIX_AGENT from envSetup is layered onto baseEnv", () => {
    const entry = mkEntry({ envSetup: "export MATRIX_AGENT=cognee-claude" });
    const out = injectIdentityEnv(entry, {});
    expect(out.MATRIX_AGENT).toBe("cognee-claude");
  });

  test("envSetup vars + git identity coexist", () => {
    const entry = mkEntry({
      gitAuthorName: "n",
      gitAuthorEmail: "e@x",
      envSetup: "export MATRIX_AGENT=m && export MATRIX_HOMESERVER=h",
    });
    const out = injectIdentityEnv(entry, { PATH: "/usr/bin" });
    expect(out.MATRIX_AGENT).toBe("m");
    expect(out.MATRIX_HOMESERVER).toBe("h");
    expect(out.GIT_AUTHOR_NAME).toBe("n");
    expect(out.PATH).toBe("/usr/bin");
  });

  test("envSetup overrides baseEnv value for same key", () => {
    const entry = mkEntry({ envSetup: "export MATRIX_AGENT=new" });
    const out = injectIdentityEnv(entry, { MATRIX_AGENT: "old" });
    expect(out.MATRIX_AGENT).toBe("new");
  });

  test("malformed envSetup propagates IdentityEnvError", () => {
    const entry = mkEntry({ envSetup: "export FOO=$(date)" });
    expect(() => injectIdentityEnv(entry, {})).toThrow(IdentityEnvError);
  });

  test("returns frozen object — caller cannot mutate", () => {
    const entry = mkEntry({ gitAuthorName: "n", gitAuthorEmail: "e@x" });
    const out = injectIdentityEnv(entry, {});
    expect(Object.isFrozen(out)).toBe(true);
  });

  test("baseEnv is NOT mutated", () => {
    const base = { PATH: "/usr/bin" };
    const entry = mkEntry({ gitAuthorName: "n", gitAuthorEmail: "e@x" });
    injectIdentityEnv(entry, base);
    expect(base).toEqual({ PATH: "/usr/bin" });
    expect("GIT_AUTHOR_NAME" in base).toBe(false);
  });
});
