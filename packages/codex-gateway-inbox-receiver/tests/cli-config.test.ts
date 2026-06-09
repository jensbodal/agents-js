import { describe, expect, test } from "bun:test";
import { curlFetch } from "@agents-js/gateway-inbox-runtime";
import { missingRequiredReceiverCliEnv, readReceiverCliConfig } from "../src/cli-config.ts";

describe("readReceiverCliConfig", () => {
  test("maps primary env names, numeric options, auto-reply, and curl transport", () => {
    const config = readReceiverCliConfig(
      {
        CODEX_GATEWAY_IDENTITY: "olthoi0-codex-0",
        CODEX_GATEWAY_URL: "https://gw.test",
        CODEX_WORKSPACE: "/workspace",
        CODEX_GATEWAY_KEY_CMD: "keycmd",
        CODEX_GATEWAY_CURSOR_PATH: "/cursor.json",
        CODEX_GATEWAY_POLL_INTERVAL_MS: "250",
        CODEX_GATEWAY_POLL_LIMIT: "7",
        CODEX_GATEWAY_AUTO_REPLY: "true",
        CODEX_GATEWAY_REPLY_TARGET: "coordinator",
        CODEX_GATEWAY_SKIP_GIT_REPO_CHECK: "true",
        CODEX_GATEWAY_FETCH: "curl",
        CODEX_GATEWAY_SENDER_ALLOWLIST: "ajs-claude hostname-null-claude-0",
      },
      "/cwd",
    );

    expect(config).toMatchObject({
      identity: "olthoi0-codex-0",
      gatewayUrl: "https://gw.test",
      workspace: "/workspace",
      keyCommand: "keycmd",
      cursorPath: "/cursor.json",
      intervalMs: 250,
      limit: 7,
      autoReply: true,
      replyTarget: "coordinator",
      skipGitRepoCheck: true,
    });
    expect(config.fetchImpl).toBe(curlFetch);
    expect([...config.senderAllowlist]).toEqual(["ajs-claude", "hostname-null-claude-0"]);
    expect(missingRequiredReceiverCliEnv(config)).toBe(false);
  });

  test("falls back to agents-js aliases and cwd, preserving native fetch by default", () => {
    const config = readReceiverCliConfig(
      {
        AGENTS_GATEWAY_SUB: "olthoi0-codex-0",
        AGENTS_GATEWAY_URL: "https://gw.test",
        AGENTS_GATEWAY_KEY_CMD: "keycmd",
        CODEX_GATEWAY_POLL_INTERVAL_MS: "not-a-number",
      },
      "/cwd",
    );

    expect(config.identity).toBe("olthoi0-codex-0");
    expect(config.gatewayUrl).toBe("https://gw.test");
    expect(config.workspace).toBe("/cwd");
    expect(config.keyCommand).toBe("keycmd");
    expect(config.intervalMs).toBeUndefined();
    expect(config.autoReply).toBe(false);
    expect(config.skipGitRepoCheck).toBe(false);
    expect(config.fetchImpl).toBeUndefined();
    expect([...config.senderAllowlist]).toEqual([]);
    expect(missingRequiredReceiverCliEnv(config)).toBe(false);
  });

  test("reports missing required launch env", () => {
    const config = readReceiverCliConfig({}, "/cwd");

    expect(missingRequiredReceiverCliEnv(config)).toBe(true);
  });
});
