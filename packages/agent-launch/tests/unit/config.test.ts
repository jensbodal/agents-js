/**
 * Tests for config loader + schema validation.
 *
 * Phase 1 coverage:
 * - well-formed parse (no per-agent validation at load time)
 * - lazy normalization: per-agent validation happens in `resolveAgentEntry`
 * - extra-field round-trip
 * - file load
 * - multi-profile regression (PR #99 cognee-codex review fix): mixed
 *   config with claude-code Phase-1 agent + non-Phase-1 profiles
 *   (codex without fresh_flags, virtual profile with nulls) loads
 *   successfully; resolving the valid agent succeeds; resolving a
 *   malformed profile still throws.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LaunchConfigError,
  loadLaunchConfig,
  parseLaunchConfig,
  resolveAgentEntry,
} from "../../src/config.ts";

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/cognee-claude-only.json",
);

const MIXED_FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/multi-profile-mixed.json",
);

describe("parseLaunchConfig — well-formed input", () => {
  test("cognee-claude fixture parses (lazy — raw entries preserved)", async () => {
    const text = await readFile(FIXTURE_PATH, "utf8");
    const config = parseLaunchConfig(text, FIXTURE_PATH);
    expect(config.version).toBe("0.1.0");
    expect(Object.keys(config.agents)).toEqual(["cognee-claude"]);
    // Raw entry shape — not yet normalized
    const raw = config.agents["cognee-claude"] as Record<string, unknown>;
    expect(raw.tmux_session).toBe("cognee-claude");
    expect(raw.harness).toBe("claude-code");
    expect(raw.fresh_flags).toContain("--agent cognee-claude");
  });

  test("resolveAgentEntry normalizes the selected entry to AgentEntry shape", async () => {
    const config = await loadLaunchConfig(FIXTURE_PATH);
    const entry = resolveAgentEntry(config, "cognee-claude");
    expect(entry.tmuxSession).toBe("cognee-claude");
    expect(entry.harness).toBe("claude-code");
    expect(entry.binary).toBe("claude");
    expect(entry.workspace).toBe("/Users/jensbodal/workspace/dot-cognee");
    expect(entry.freshFlags).toContain("--agent cognee-claude");
    expect(entry.gitAuthorName).toBe("cognee-claude");
    expect(entry.gitAuthorEmail).toBe("cognee-claude@agents.example");
    expect(entry.envSetup).toBe("export MATRIX_AGENT=cognee-claude");
    expect(entry.matrixMxid).toBe("@cognee-claude:matrix.example");
  });

  test("extra fields round-trip through entry.extra after normalization", async () => {
    const config = await loadLaunchConfig(FIXTURE_PATH);
    const entry = resolveAgentEntry(config, "cognee-claude");
    expect(entry.extra.identity_files).toEqual(["CLAUDE.md", ".claude/agents/cognee-claude.md"]);
    expect(entry.extra.model).toBe("claude-opus-4-7");
    expect(entry.extra.notes).toContain("Test fixture");
    // Promoted fields are NOT in extra
    expect(entry.extra.tmux_session).toBeUndefined();
    expect(entry.extra.harness).toBeUndefined();
  });

  test("channel_env is promoted to entry.channelEnv (not left in extra)", () => {
    const config = parseLaunchConfig(
      JSON.stringify({
        version: "0.1.0",
        agents: {
          foo: {
            tmux_session: "foo",
            harness: "claude-code",
            binary: "claude",
            workspace: "/tmp",
            fresh_flags: "--agent foo",
            channel_env: "export CH_GATEWAY_URL=https://gw && export CH_GATEWAY_IDENTITY=foo",
          },
        },
      }),
      "inline.json",
    );
    const entry = resolveAgentEntry(config, "foo");
    expect(entry.channelEnv).toBe(
      "export CH_GATEWAY_URL=https://gw && export CH_GATEWAY_IDENTITY=foo",
    );
    expect(entry.extra.channel_env).toBeUndefined();
  });

  test("channel_env wrong type (not a string) throws", () => {
    const config = parseLaunchConfig(
      JSON.stringify({
        version: "0.1.0",
        agents: {
          foo: {
            tmux_session: "foo",
            harness: "claude-code",
            binary: "claude",
            workspace: "/tmp",
            fresh_flags: "--agent foo",
            channel_env: { not: "a string" },
          },
        },
      }),
      "inline.json",
    );
    expect(() => resolveAgentEntry(config, "foo")).toThrow(/field "channel_env" must be a string/);
  });

  test("allowed_tools is promoted to entry.allowedTools (not left in extra)", () => {
    const config = parseLaunchConfig(
      JSON.stringify({
        version: "0.1.0",
        agents: {
          foo: {
            tmux_session: "foo",
            harness: "claude-code",
            binary: "claude",
            workspace: "/tmp",
            fresh_flags: "--agent foo",
            allowed_tools: [
              "mcp__claude-channel-adapter__agents_js_send",
              "mcp__claude-channel-adapter__agents_js_reply",
            ],
          },
        },
      }),
      "inline.json",
    );
    const entry = resolveAgentEntry(config, "foo");
    expect(entry.allowedTools).toEqual([
      "mcp__claude-channel-adapter__agents_js_send",
      "mcp__claude-channel-adapter__agents_js_reply",
    ]);
    expect(entry.extra.allowed_tools).toBeUndefined();
  });

  test("allowed_tools wrong type (not an array of strings) throws", () => {
    const config = parseLaunchConfig(
      JSON.stringify({
        version: "0.1.0",
        agents: {
          foo: {
            tmux_session: "foo",
            harness: "claude-code",
            binary: "claude",
            workspace: "/tmp",
            fresh_flags: "--agent foo",
            allowed_tools: "not-an-array",
          },
        },
      }),
      "inline.json",
    );
    expect(() => resolveAgentEntry(config, "foo")).toThrow(
      /field "allowed_tools" must be an array of strings/,
    );
  });

  test("top-level lan_domain is parsed onto LaunchConfig.lanDomain", () => {
    const config = parseLaunchConfig(
      JSON.stringify({ version: "0.1.0", lan_domain: "q4m.dev", agents: {} }),
      "inline.json",
    );
    expect(config.lanDomain).toBe("q4m.dev");
  });

  test("lanDomain is undefined when lan_domain is absent or non-string", () => {
    expect(
      parseLaunchConfig(JSON.stringify({ version: "0.1.0", agents: {} }), "inline.json").lanDomain,
    ).toBeUndefined();
    expect(
      parseLaunchConfig(JSON.stringify({ version: "0.1.0", lan_domain: 42, agents: {} }), "x.json")
        .lanDomain,
    ).toBeUndefined();
  });
});

describe("parseLaunchConfig — top-level error cases", () => {
  test("invalid JSON throws LaunchConfigError with path", () => {
    expect(() => parseLaunchConfig("{ not json", "test.json")).toThrow(LaunchConfigError);
    try {
      parseLaunchConfig("{ not json", "test.json");
    } catch (err) {
      expect(err).toBeInstanceOf(LaunchConfigError);
      const e = err as LaunchConfigError;
      expect(e.path).toBe("test.json");
      expect(e.message).toContain("invalid JSON");
    }
  });

  test("top-level not an object", () => {
    expect(() => parseLaunchConfig("[]", "x.json")).toThrow(/JSON object at top level/);
  });

  test("missing top-level version", () => {
    expect(() => parseLaunchConfig('{"agents":{}}', "x.json")).toThrow(
      /"version" must be a string/,
    );
  });

  test("missing top-level agents", () => {
    expect(() => parseLaunchConfig('{"version":"0.1.0"}', "x.json")).toThrow(
      /"agents" must be an object/,
    );
  });

  test("parseLaunchConfig does NOT validate per-agent fields (lazy fix)", () => {
    // Per PR #99 cognee-codex review: loading must succeed for configs
    // with non-Phase-1 profiles (codex without fresh_flags, virtual
    // profiles with nulls). Per-agent validation moves to resolveAgentEntry.
    const text = JSON.stringify({
      version: "0.1.0",
      agents: {
        bad: {
          tmux_session: "bad",
          // missing harness, binary, workspace, fresh_flags — would have failed before
        },
      },
    });
    expect(() => parseLaunchConfig(text, "x.json")).not.toThrow();
  });
});

describe("resolveAgentEntry — per-agent validation (lazy)", () => {
  test("missing required field on SELECTED entry throws", () => {
    const config = parseLaunchConfig(
      JSON.stringify({
        version: "0.1.0",
        agents: {
          foo: { tmux_session: "foo", binary: "x", workspace: "/tmp", fresh_flags: "--y" },
        },
      }),
      "x.json",
    );
    expect(() => resolveAgentEntry(config, "foo")).toThrow(/missing required field "harness"/);
  });

  test("wrong-type field on SELECTED entry throws", () => {
    const config = parseLaunchConfig(
      JSON.stringify({
        version: "0.1.0",
        agents: {
          foo: {
            tmux_session: "foo",
            harness: "claude-code",
            binary: 123,
            workspace: "/tmp",
            fresh_flags: "--y",
          },
        },
      }),
      "x.json",
    );
    expect(() => resolveAgentEntry(config, "foo")).toThrow(/field "binary" must be a string/);
  });

  test("entry not an object throws when resolved", () => {
    const config = parseLaunchConfig(
      JSON.stringify({
        version: "0.1.0",
        agents: { foo: "not-an-object" },
      }),
      "x.json",
    );
    expect(() => resolveAgentEntry(config, "foo")).toThrow(/agent "foo" entry must be an object/);
  });

  test("optional field wrong type rejected at resolve", () => {
    const config = parseLaunchConfig(
      JSON.stringify({
        version: "0.1.0",
        agents: {
          foo: {
            tmux_session: "foo",
            harness: "claude-code",
            binary: "x",
            workspace: "/tmp",
            fresh_flags: "--y",
            git_author_name: 42,
          },
        },
      }),
      "x.json",
    );
    expect(() => resolveAgentEntry(config, "foo")).toThrow(
      /field "git_author_name" must be a string when present/,
    );
  });
});

describe("loadLaunchConfig — file IO", () => {
  test("reads fixture file from disk + parses", async () => {
    const config = await loadLaunchConfig(FIXTURE_PATH);
    expect(config.version).toBe("0.1.0");
    expect(config.agents["cognee-claude"]).toBeDefined();
  });
});

describe("resolveAgentEntry — name resolution", () => {
  test("returns normalized entry when name matches", async () => {
    const config = await loadLaunchConfig(FIXTURE_PATH);
    const entry = resolveAgentEntry(config, "cognee-claude");
    expect(entry.tmuxSession).toBe("cognee-claude");
  });

  test("throws with available-names hint on unknown name", async () => {
    const config = await loadLaunchConfig(FIXTURE_PATH);
    expect(() => resolveAgentEntry(config, "ghost")).toThrow(/agent "ghost" not found/);
    try {
      resolveAgentEntry(config, "ghost");
    } catch (err) {
      expect(err).toBeInstanceOf(LaunchConfigError);
      expect((err as Error).message).toContain("available: cognee-claude");
    }
  });
});

describe("multi-profile regression (PR #99 cognee-codex review fix)", () => {
  test("config with claude-code + codex (no fresh_flags) + virtual (nulls) loads successfully", async () => {
    const config = await loadLaunchConfig(MIXED_FIXTURE_PATH);
    expect(Object.keys(config.agents).sort()).toEqual([
      "cognee-claude",
      "cognee-codex",
      "jens-proxy",
    ]);
  });

  test("resolving the valid claude-code agent succeeds despite unrelated invalid profiles", async () => {
    const config = await loadLaunchConfig(MIXED_FIXTURE_PATH);
    const entry = resolveAgentEntry(config, "cognee-claude");
    expect(entry.tmuxSession).toBe("cognee-claude");
    expect(entry.harness).toBe("claude-code");
    expect(entry.gitAuthorName).toBe("cognee-claude");
  });

  test("resolving cognee-codex (missing fresh_flags) throws clearly", async () => {
    const config = await loadLaunchConfig(MIXED_FIXTURE_PATH);
    expect(() => resolveAgentEntry(config, "cognee-codex")).toThrow(
      /agent "cognee-codex" is missing required field "fresh_flags"/,
    );
  });

  test("resolving jens-proxy (virtual, null fields) throws on the first null", async () => {
    const config = await loadLaunchConfig(MIXED_FIXTURE_PATH);
    // tmux_session is null → fails requireString
    expect(() => resolveAgentEntry(config, "jens-proxy")).toThrow(
      /field "tmux_session" must be a string/,
    );
  });
});
