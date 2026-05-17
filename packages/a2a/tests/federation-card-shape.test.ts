import { describe, expect, test } from "bun:test";
import type { HarnessCapabilityEntry } from "../src/index.ts";

describe("HarnessCapabilityEntry — federation card shape", () => {
  // Locks the back-compat guarantee: any agent-card emitted by a
  // single-host gateway predates the federation fields, so a value
  // built without `source`/`remote` must remain assignable and must
  // serialize cleanly (no undefined keys leaking into JSON).
  test("legacy entry without source field round-trips through JSON.stringify (back-compat)", () => {
    const legacy: HarnessCapabilityEntry = {
      id: "opencode",
      displayName: "OpenCode ACP",
      primary: true,
      ready: true,
    };
    const roundTripped = JSON.parse(JSON.stringify(legacy)) as HarnessCapabilityEntry;
    expect(roundTripped).toEqual(legacy);
    expect("source" in roundTripped).toBe(false);
    expect("remote" in roundTripped).toBe(false);
  });

  // Documents the explicit-local case: callers may opt in to writing
  // `source: "local"` rather than relying on the omitted-defaults-to-local
  // rule, and that form must be valid without any remote envelope.
  test("entry with source: 'local' and no remote envelope is valid", () => {
    const local: HarnessCapabilityEntry = {
      id: "opencode",
      displayName: "OpenCode ACP",
      primary: true,
      ready: true,
      source: "local",
    };
    expect(local.source).toBe("local");
    expect(local.remote).toBeUndefined();
  });

  // The happy-path federation case: a remote-backed harness with a
  // resolvable hostname routes through the child gateway's own URL,
  // so coordinatorUrl is absent and gatewayUrl is the direct target.
  test("entry with source: 'remote' and full remote envelope (resolvable hostname) is valid", () => {
    const remote: HarnessCapabilityEntry = {
      id: "opencode",
      displayName: "OpenCode ACP",
      primary: false,
      ready: true,
      source: "remote",
      remote: {
        gatewayUrl: "https://child.example.com/agent",
        hostnameMode: "resolvable",
        childAgentId: "child-gateway-1",
      },
    };
    expect(remote.remote?.hostnameMode).toBe("resolvable");
    expect(remote.remote?.coordinatorUrl).toBeUndefined();
    expect(remote.remote?.gatewayUrl).toContain("child.example.com");
  });

  // The hostname-null case: child gateway can't be reached directly,
  // so dispatches are rewritten to flow through the coordinator. The
  // envelope carries both the rewritten gatewayUrl and the coordinator
  // endpoint so federation peers know to use the indirect path.
  test("entry with source: 'remote' + remote.hostnameMode: 'null' + coordinatorUrl is valid", () => {
    const indirect: HarnessCapabilityEntry = {
      id: "gemini",
      displayName: "Gemini ACP",
      primary: false,
      ready: false,
      source: "remote",
      remote: {
        gatewayUrl: "coord://child-gateway-2",
        hostnameMode: "null",
        coordinatorUrl: "https://coordinator.example.com",
        childAgentId: "child-gateway-2",
      },
    };
    expect(indirect.remote?.hostnameMode).toBe("null");
    expect(indirect.remote?.coordinatorUrl).toBe("https://coordinator.example.com");
  });

  // Compile-time invariant: source: "remote" without a remote envelope
  // is a malformed federation entry — peers would have nowhere to
  // dispatch. Enforce this in the type system so it can't ship.
  test("type system rejects source: 'remote' without remote envelope at compile time", () => {
    // @ts-expect-error — source: "remote" requires the remote envelope
    const malformed: HarnessCapabilityEntry = {
      id: "opencode",
      displayName: "OpenCode ACP",
      primary: true,
      ready: true,
      source: "remote",
    };
    expect(malformed.id).toBe("opencode");
  });

  // childAgentId is the federation peer's stable identifier (matches
  // its own card.name) — without it, dispatch responses can't be
  // correlated back to the originating child. Locking this as required.
  test("childAgentId is required when remote envelope is present", () => {
    const missingChildId: HarnessCapabilityEntry = {
      id: "opencode",
      displayName: "OpenCode ACP",
      primary: true,
      ready: true,
      source: "remote",
      // @ts-expect-error — `childAgentId` is required inside the remote envelope
      remote: {
        gatewayUrl: "https://child.example.com/agent",
        hostnameMode: "resolvable",
      },
    };
    expect(missingChildId.id).toBe("opencode");
  });

  // JSON.stringify drops undefined values, so omitted optional fields
  // must not appear as `"source": null` or similar on the wire. This
  // keeps the federation card byte-identical to legacy cards when no
  // federation is configured.
  test("optional fields are omitted on serialize when undefined", () => {
    const legacy: HarnessCapabilityEntry = {
      id: "opencode",
      displayName: "OpenCode ACP",
      primary: true,
      ready: true,
    };
    const json = JSON.stringify(legacy);
    expect(json).not.toContain("source");
    expect(json).not.toContain("remote");
    expect(json).not.toContain("null");
  });
});
