/**
 * Federation peer-view tests for the AJS-23 v1 contract.
 *
 * This file covers the wire-shape side of the federation spec from the
 * perspective of an A2A peer fetching `/.well-known/agent-card.json`:
 *
 *   1. A gateway's `capabilities.harnesses` array carries a mix of
 *      `source: "local"` entries (implicitly, via omission) and explicit
 *      `source: "remote"` entries with a `remote` envelope.
 *   2. JSON round-trip preserves both shapes faithfully — a peer that
 *      narrows to `{ id, displayName, source? }` can ignore the `remote`
 *      envelope entirely without breaking parse.
 *   3. The hostname-mode env contract that backs the `remote.gatewayUrl`
 *      / `remote.coordinatorUrl` split resolves cleanly only when the
 *      `null` mode is paired with a coordinator URL.
 *
 * This file does NOT exercise the lane-manager dispatch path for remote
 * entries — that guard-rail lives in `packages/host/tests/remote-source-routing.test.ts`
 * and is intentionally `test.todo()` for v1 (the lane manager does not
 * yet branch on `source` in v1).
 */

import { describe, expect, test } from "bun:test";
import { buildAgentCard, type HarnessCapabilityEntry } from "@agents-js/a2a";
import { resolveRemoteGatewayEnv } from "../../../packages/gateway-runtime/src/remote-gateway-env.ts";

/**
 * Build a minimal two-entry fleet: one local harness (omitted source)
 * and one remote harness (resolvable child gateway). Inline so tests
 * don't share mutable fixture state.
 */
function buildMixedFleetCard(): HarnessCapabilityEntry[] {
  return [
    {
      id: "opencode",
      displayName: "OpenCode ACP",
      primary: true,
      ready: true,
    },
    {
      id: "gemini-remote",
      displayName: "Gemini ACP (remote)",
      primary: false,
      ready: true,
      source: "remote",
      remote: {
        gatewayUrl: "https://child-a.example.com:7777",
        hostnameMode: "resolvable",
        childAgentId: "child-gateway-a",
      },
    },
  ];
}

describe("federation peer view of remote harnesses on the agent card", () => {
  // Both entry kinds must coexist on the same card; the discriminated
  // union narrows on `source`, and a card built from the mixed fleet
  // must serialize both entries with their canonical shapes intact.
  test("a card with one local + one remote entry serializes both with correct shapes", () => {
    const card = buildAgentCard({ name: "parent-gateway", description: "test" });
    card.capabilities.harnesses = buildMixedFleetCard();

    const local = card.capabilities.harnesses?.find((h) => h.id === "opencode");
    const remote = card.capabilities.harnesses?.find((h) => h.id === "gemini-remote");

    // Local entry: no `source` field, no `remote` envelope on the wire.
    expect(local).toBeDefined();
    expect(local?.source).toBeUndefined();
    expect((local as { remote?: unknown }).remote).toBeUndefined();

    // Remote entry: explicit `source: "remote"` plus a typed envelope.
    expect(remote).toBeDefined();
    expect(remote?.source).toBe("remote");
    if (remote?.source !== "remote") throw new Error("type-narrowing precondition");
    expect(remote.remote.gatewayUrl).toBe("https://child-a.example.com:7777");
    expect(remote.remote.hostnameMode).toBe("resolvable");
    expect(remote.remote.childAgentId).toBe("child-gateway-a");
    expect(remote.remote.coordinatorUrl).toBeUndefined();
  });

  // A federation peer dispatching to a remote-backed harness must see
  // `source: "remote"` after JSON round-trip (this is the cache-key
  // signal that says "do not ask the parent gateway to spawn locally").
  test("a peer fetching the card observes `source: 'remote'` on the federated entry", () => {
    const card = buildAgentCard({ name: "parent-gateway", description: "test" });
    card.capabilities.harnesses = buildMixedFleetCard();

    const wire = JSON.parse(JSON.stringify(card.capabilities)) as {
      harnesses: HarnessCapabilityEntry[];
    };
    const remoteOnWire = wire.harnesses.find((h) => h.id === "gemini-remote");
    expect(remoteOnWire?.source).toBe("remote");
    if (remoteOnWire?.source !== "remote") throw new Error("type-narrowing precondition");
    // The envelope survives serialization intact — peers can pull
    // `gatewayUrl` straight from the parsed card.
    expect(remoteOnWire.remote.gatewayUrl).toBe("https://child-a.example.com:7777");
    expect(remoteOnWire.remote.childAgentId).toBe("child-gateway-a");
  });

  // Forward-compat for older peers that only know about `{ id,
  // displayName, source? }`: narrowing the entry to that shape MUST
  // still produce correct values for the well-understood fields, and
  // ignoring the `remote` envelope must not affect parse correctness.
  test("a peer can ignore `remote` envelopes (treat them as opaque) without breaking parse", () => {
    const card = buildAgentCard({ name: "parent-gateway", description: "test" });
    card.capabilities.harnesses = buildMixedFleetCard();

    const wire = JSON.parse(JSON.stringify(card.capabilities)) as {
      harnesses: Array<{ id: string; displayName: string; source?: "local" | "remote" }>;
    };

    expect(wire.harnesses).toHaveLength(2);
    const narrowed = wire.harnesses.map((h) => ({
      id: h.id,
      displayName: h.displayName,
      source: h.source,
    }));
    expect(narrowed).toEqual([
      { id: "opencode", displayName: "OpenCode ACP", source: undefined },
      { id: "gemini-remote", displayName: "Gemini ACP (remote)", source: "remote" },
    ]);
  });

  // Wire-economy + forward-compat: a local entry must not emit a
  // `remote: undefined` slot on the JSON wire. Older peers seeing the
  // key — even with a null/undefined value — could mis-classify the
  // entry as remote-backed. Test JSON output, not in-memory shape.
  test("`source: 'local'` entries omit the `remote` envelope entirely on the wire", () => {
    const card = buildAgentCard({ name: "parent-gateway", description: "test" });
    card.capabilities.harnesses = buildMixedFleetCard();

    const serialized = JSON.stringify(card.capabilities.harnesses);
    const onWire = JSON.parse(serialized) as Array<Record<string, unknown>>;

    const local = onWire.find((h) => h.id === "opencode");
    expect(local).toBeDefined();
    // The key MUST NOT appear at all — `in` is the strict test.
    expect("remote" in (local as object)).toBe(false);
    expect("source" in (local as object)).toBe(false);

    // The remote entry, by contrast, MUST carry both keys on the wire.
    const remote = onWire.find((h) => h.id === "gemini-remote");
    expect(remote).toBeDefined();
    expect("remote" in (remote as object)).toBe(true);
    expect("source" in (remote as object)).toBe(true);
  });
});

describe("hostname-null env composition with --hostname CLI flag", () => {
  // The federation envelope's `coordinatorUrl` only appears when the
  // backing gateway runs in `null` hostname mode. The env parser is the
  // single composition point both the CLI (`--hostname null`) and raw
  // env eventually feed into; validate from the federation contract POV
  // that the composition resolves with the coordinator URL surfaced.
  test("AJS_GATEWAY_HOSTNAME_MODE=null + AJS_GATEWAY_COORDINATOR_URL=https://... resolves cleanly", () => {
    const cfg = resolveRemoteGatewayEnv({
      AJS_GATEWAY_HOSTNAME_MODE: "null",
      AJS_GATEWAY_COORDINATOR_URL: "https://coord.example.com/registry",
    });
    expect(cfg.hostnameMode).toBe("null");
    expect(cfg.coordinatorUrl).toBe("https://coord.example.com/registry");
  });

  // Null mode without a coordinator URL is undiscoverable — the
  // federation envelope would have no `gatewayUrl` source. Must refuse
  // to resolve loudly so a misconfigured gateway never starts.
  test("AJS_GATEWAY_HOSTNAME_MODE=null without coordinator URL refuses to resolve", () => {
    expect(() => resolveRemoteGatewayEnv({ AJS_GATEWAY_HOSTNAME_MODE: "null" })).toThrow(
      /AJS_GATEWAY_COORDINATOR_URL/,
    );
  });

  // Default (resolvable) mode advertises a direct hostname; a
  // coordinator URL in env is a red herring and MUST NOT bleed into
  // the resolved config — otherwise the federation envelope downstream
  // could mix a resolvable `gatewayUrl` with a coordinator URL it
  // shouldn't be using.
  test("AJS_GATEWAY_HOSTNAME_MODE=resolvable (default) ignores coordinator URL even when set", () => {
    const cfg = resolveRemoteGatewayEnv({
      AJS_GATEWAY_HOSTNAME_MODE: "resolvable",
      AJS_GATEWAY_COORDINATOR_URL: "https://coord.example.com/registry",
    });
    expect(cfg.hostnameMode).toBe("resolvable");
    expect(cfg.coordinatorUrl).toBeUndefined();
  });
});
