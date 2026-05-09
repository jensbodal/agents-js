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
  test("baseline is empty — no global secret forwarding", () => {
    expect(BASELINE_AGENT_SECRET_ENV_KEYS).toEqual([]);
  });

  test("runtime with no authEnvKeys → empty policy (zero secret leakage)", () => {
    const policy = buildHostRuntimeEnvPolicy(fakeRuntime());
    expect(policy.agentSecretEnvKeys).toEqual([]);
  });

  test("returns exactly the runtime's declared authEnvKeys", () => {
    const policy = buildHostRuntimeEnvPolicy(
      fakeRuntime(["OPENCODE_API_KEY", "OPENROUTER_API_KEY"]),
    );
    expect(policy.agentSecretEnvKeys).toEqual(["OPENCODE_API_KEY", "OPENROUTER_API_KEY"]);
  });

  test("does not forward ANTHROPIC_API_KEY or MATRIX_ACCESS_TOKEN unless the runtime declares them", () => {
    // A runtime that does not declare ANTHROPIC_API_KEY must not see it
    // in its env policy. Same for MATRIX_ACCESS_TOKEN. This is the
    // regression guard for the removed global baseline.
    const policy = buildHostRuntimeEnvPolicy(fakeRuntime(["UNRELATED_KEY"]));
    const keys = policy.agentSecretEnvKeys ?? [];
    expect(keys).not.toContain("ANTHROPIC_API_KEY");
    expect(keys).not.toContain("MATRIX_ACCESS_TOKEN");
    expect(keys).toContain("UNRELATED_KEY");
  });

  test("forwards a key only when the runtime explicitly declares it", () => {
    const policy = buildHostRuntimeEnvPolicy(fakeRuntime(["ANTHROPIC_API_KEY"]));
    expect(policy.agentSecretEnvKeys).toEqual(["ANTHROPIC_API_KEY"]);
  });
});
