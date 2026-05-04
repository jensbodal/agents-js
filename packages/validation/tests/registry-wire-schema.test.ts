import { describe, expect, test } from "bun:test";
import { validateWireAgentRegistryRecord, WireAgentRegistryRecordSchema } from "../src/registry.ts";

/**
 * Wire-schema sanity tests for `WireAgentRegistryRecordSchema`.
 *
 * The schema is the single source of truth for both inbound peer-sync
 * parsing AND outbound wire projection in `@agents-js/a2a-client/sync`.
 * If any of these properties drift, the security contract — "ACP launch
 * fields never traverse the peer-sync wire" — is corrupted at the
 * declaration site.
 */
describe("packages/validation/tests/registry-wire-schema.test.ts", () => {
  /** A canonical valid wire record. Built fresh per test to keep cases isolated. */
  function validRecord() {
    return {
      name: "valid-a2a",
      agent_id: "peerA.valid-a2a",
      kind: "a2a" as const,
      gateway_id: "peerA",
      source: "auto-reg" as const,
      registered_at: "2026-04-23T12:00:00.000Z",
    };
  }

  test("known-good A2A record passes", () => {
    const result = validateWireAgentRegistryRecord(validRecord());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.name).toBe("valid-a2a");
      expect(result.value.kind).toBe("a2a");
    }
  });

  test("kind=acp record is rejected (peer sync is A2A-only)", () => {
    const acpRecord = {
      ...validRecord(),
      kind: "acp",
      harness: "claude",
    };
    const result = validateWireAgentRegistryRecord(acpRecord);
    expect(result.valid).toBe(false);
  });

  test("empty name is rejected", () => {
    const result = validateWireAgentRegistryRecord({ ...validRecord(), name: "" });
    expect(result.valid).toBe(false);
  });

  test("empty agent_id is rejected", () => {
    const result = validateWireAgentRegistryRecord({ ...validRecord(), agent_id: "" });
    expect(result.valid).toBe(false);
  });

  test("empty gateway_id is rejected", () => {
    const result = validateWireAgentRegistryRecord({ ...validRecord(), gateway_id: "" });
    expect(result.valid).toBe(false);
  });

  test("invalid source enum is rejected", () => {
    const result = validateWireAgentRegistryRecord({
      ...validRecord(),
      source: "made-up-source",
    });
    expect(result.valid).toBe(false);
  });

  /**
   * The reviewer's load-bearing security guarantee: a malicious peer
   * attaches `command` / `args` / `env` / `workspaceFlag` to an A2A
   * wire record hoping the receiver merges them. The schema is
   * `.strip()`-mode so unknown keys are silently dropped on parse.
   */
  test("ACP launch fields attached to an A2A wire record are stripped", () => {
    const smuggled = {
      ...validRecord(),
      command: "/bin/leaked",
      args: ["--exfiltrate"],
      env: { SECRET: "x" },
      workspaceFlag: "--cwd",
    };
    const result = validateWireAgentRegistryRecord(smuggled);
    expect(result.valid).toBe(true);
    if (result.valid) {
      const accepted = result.value as Record<string, unknown>;
      expect(accepted.command).toBeUndefined();
      expect(accepted.args).toBeUndefined();
      expect(accepted.env).toBeUndefined();
      expect(accepted.workspaceFlag).toBeUndefined();
    }
  });

  /**
   * Forward-compatibility property: a future protocol bump that adds a
   * new structural string field (e.g. `region`) must not break older
   * receivers. `.strip()` guarantees the unknown field disappears on
   * parse without rejecting the record outright.
   */
  test("unknown forward-compatible field is stripped, not rejected", () => {
    const future = { ...validRecord(), region: "us-west-2" };
    const result = validateWireAgentRegistryRecord(future);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect((result.value as Record<string, unknown>).region).toBeUndefined();
    }
  });

  test("optional structural fields are preserved when present", () => {
    const rich = {
      ...validRecord(),
      url: "http://va.test",
      protocol_version: "0.0.1a",
      health_check_url: "http://va.test/health",
      description: "valid agent",
      actor_type: "machine" as const,
    };
    const result = validateWireAgentRegistryRecord(rich);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.url).toBe("http://va.test");
      expect(result.value.protocol_version).toBe("0.0.1a");
      expect(result.value.health_check_url).toBe("http://va.test/health");
      expect(result.value.description).toBe("valid agent");
      expect(result.value.actor_type).toBe("machine");
    }
  });

  test("schema directly via .parse() throws on invalid input", () => {
    expect(() => WireAgentRegistryRecordSchema.parse({ kind: "a2a" })).toThrow();
  });

  test("schema directly via .safeParse() returns success on valid input", () => {
    const parsed = WireAgentRegistryRecordSchema.safeParse(validRecord());
    expect(parsed.success).toBe(true);
  });

  test("non-object input is rejected", () => {
    for (const bad of ["string", 42, null, undefined, []]) {
      const result = validateWireAgentRegistryRecord(bad);
      expect(result.valid).toBe(false);
    }
  });
});
