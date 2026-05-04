import { describe, expect, test } from "bun:test";
import type { ResolvedGatewayRuntime } from "@agents-js/gateway-runtime";
import {
  BASELINE_AGENT_SECRET_ENV_KEYS,
  buildHostRuntimeEnvPolicy,
} from "../src/runtime-env-policy.ts";

/**
 * Minimal {@link ResolvedGatewayRuntime} factory for env-policy tests.
 * Only `definition.authEnvKeys` is consulted, so the rest of the resolved
 * runtime can be a structural stub — we cast at the boundary rather than
 * pulling the curated registry into the test surface.
 */
function fakeRuntime(authEnvKeys?: readonly string[]): ResolvedGatewayRuntime {
  return {
    definition: {
      id: "test-harness",
      displayName: "Test Harness",
      description: "Fixture for runtime-env-policy tests",
      command: "noop",
      args: [],
      install: { kind: "external" },
      resolvesFromWorkspaceBin: false,
      ...(authEnvKeys !== undefined ? { authEnvKeys } : {}),
    },
    acp: { command: "noop", args: [] },
    agentCard: {
      name: "Test Harness",
      description: "Fixture",
      version: "0.0.0",
    },
  } as unknown as ResolvedGatewayRuntime;
}

describe("buildHostRuntimeEnvPolicy", () => {
  test("baseline secrets are always present", () => {
    const policy = buildHostRuntimeEnvPolicy(fakeRuntime());
    for (const key of BASELINE_AGENT_SECRET_ENV_KEYS) {
      expect(policy.agentSecretEnvKeys).toContain(key);
    }
    expect(BASELINE_AGENT_SECRET_ENV_KEYS).toContain("MATRIX_ACCESS_TOKEN");
    expect(BASELINE_AGENT_SECRET_ENV_KEYS).toContain("ANTHROPIC_API_KEY");
  });

  test("merges harness authEnvKeys onto the baseline", () => {
    const policy = buildHostRuntimeEnvPolicy(
      fakeRuntime(["OPENCODE_API_KEY", "OPENROUTER_API_KEY"]),
    );
    const keys = policy.agentSecretEnvKeys ?? [];
    for (const key of BASELINE_AGENT_SECRET_ENV_KEYS) {
      expect(keys).toContain(key);
    }
    expect(keys).toContain("OPENCODE_API_KEY");
    expect(keys).toContain("OPENROUTER_API_KEY");
  });

  test("deduplicates when harness reasserts a baseline key", () => {
    const policy = buildHostRuntimeEnvPolicy(
      fakeRuntime(["ANTHROPIC_API_KEY", "MATRIX_ACCESS_TOKEN", "EXTRA_KEY"]),
    );
    const keys = policy.agentSecretEnvKeys ?? [];
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("EXTRA_KEY");
  });

  test("treats omitted authEnvKeys as no-op (baseline only)", () => {
    const policy = buildHostRuntimeEnvPolicy(fakeRuntime());
    expect(policy.agentSecretEnvKeys).toEqual([...BASELINE_AGENT_SECRET_ENV_KEYS]);
  });
});
