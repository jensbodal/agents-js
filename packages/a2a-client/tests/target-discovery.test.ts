import { describe, expect, test } from "bun:test";
import { type DiscoveredTarget, groupDiscoveredTargets } from "../src/index.ts";
import type { AgentRegistryRecord } from "../src/registry.ts";

function record(
  overrides: Partial<AgentRegistryRecord> & Pick<AgentRegistryRecord, "name">,
): AgentRegistryRecord {
  return {
    agent_id: `malar.local.${overrides.name}`,
    kind: "a2a",
    gateway_id: "malar.local",
    source: "manual",
    registered_at: "2026-04-27T00:00:00.000Z",
    actor_type: "machine",
    url: "http://127.0.0.1:9201",
    ...overrides,
  };
}

function target(overrides: {
  name: string;
  url?: string;
  reachability?: DiscoveredTarget["reachability"];
  errorReason?: string;
  agent_id?: string;
}): DiscoveredTarget {
  return {
    record: record({
      name: overrides.name,
      ...(overrides.url ? { url: overrides.url } : {}),
      ...(overrides.agent_id ? { agent_id: overrides.agent_id } : {}),
    }),
    ...(overrides.reachability ? { reachability: overrides.reachability } : {}),
    ...(overrides.errorReason ? { errorReason: overrides.errorReason } : {}),
  };
}

describe("groupDiscoveredTargets (WP8)", () => {
  test("default behavior groups by name with original order preserved", () => {
    const groups = groupDiscoveredTargets([
      target({ name: "tpm-agents-js", url: "http://127.0.0.1:9201" }),
      target({ name: "tpm-dot-mana", url: "http://127.0.0.1:9203" }),
      target({ name: "tpm-agents-js", url: "http://127.0.0.1:9301" }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.name).toBe("tpm-agents-js");
    expect(groups[0]?.preferred.record.url).toBe("http://127.0.0.1:9201");
    expect(groups[0]?.alternates).toHaveLength(1);
    expect(groups[0]?.alternates[0]?.record.url).toBe("http://127.0.0.1:9301");
    expect(groups[1]?.name).toBe("tpm-dot-mana");
    expect(groups[1]?.alternates).toHaveLength(0);
  });

  test("preferGateway promotes gateway entries over registry duplicates", () => {
    // Brief scenario 1: "Gateway target can be preferred over registry
    // duplicates."
    const groups = groupDiscoveredTargets(
      [
        target({
          name: "tpm-agents-js",
          url: "http://127.0.0.1:9201",
          agent_id: "malar.local.tpm-agents-js",
        }),
        target({
          name: "tpm-agents-js",
          url: "http://127.0.0.1:9200",
          agent_id: "malar.local.gateway",
        }),
      ],
      { preferGateway: true },
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.preferred.record.agent_id).toBe("malar.local.gateway");
    expect(groups[0]?.alternates).toHaveLength(1);
    expect(groups[0]?.alternates[0]?.record.agent_id).toBe("malar.local.tpm-agents-js");
  });

  test("preferGateway also promotes records named `gateway` directly", () => {
    const groups = groupDiscoveredTargets(
      [
        target({ name: "gateway", url: "http://127.0.0.1:9000" }),
        target({ name: "gateway", url: "http://127.0.0.1:9200" }),
      ],
      { preferGateway: true },
    );
    // Both are gateway-named, so order is preserved (stable sort).
    expect(groups[0]?.preferred.record.url).toBe("http://127.0.0.1:9000");
    expect(groups[0]?.alternates[0]?.record.url).toBe("http://127.0.0.1:9200");
  });

  test("hideOffline excludes offline targets from output", () => {
    // Brief scenario 2 (variant): "Offline targets can be hidden from
    // default view but retained for advanced view."
    const targets: DiscoveredTarget[] = [
      target({ name: "tpm-agents-js", url: "http://127.0.0.1:9201", reachability: "online" }),
      target({ name: "tpm-dot-mana", url: "http://127.0.0.1:9203", reachability: "offline" }),
      target({ name: "tpm-skills-js", url: "http://127.0.0.1:9204", reachability: "unknown" }),
    ];

    const hidden = groupDiscoveredTargets(targets, { hideOffline: true });
    expect(hidden).toHaveLength(2);
    expect(hidden.map((g) => g.name)).toEqual(["tpm-agents-js", "tpm-skills-js"]);

    // Same input without hideOffline preserves the offline entry —
    // brief: "Do not remove raw discovery data."
    const visible = groupDiscoveredTargets(targets);
    expect(visible).toHaveLength(3);
    expect(visible.map((g) => g.name)).toContain("tpm-dot-mana");
  });

  test("demoteOffline keeps offline visible but pushes them to alternates", () => {
    // Same name, online preferred, offline kept as alternate.
    const groups = groupDiscoveredTargets(
      [
        target({
          name: "tpm-agents-js",
          url: "http://127.0.0.1:9201",
          reachability: "offline",
          errorReason: "ECONNREFUSED",
        }),
        target({
          name: "tpm-agents-js",
          url: "http://127.0.0.1:9301",
          reachability: "online",
        }),
      ],
      { demoteOffline: true },
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.preferred.reachability).toBe("online");
    expect(groups[0]?.preferred.record.url).toBe("http://127.0.0.1:9301");
    expect(groups[0]?.alternates).toHaveLength(1);
    expect(groups[0]?.alternates[0]?.reachability).toBe("offline");
    // Brief scenario 3: "Grouping preserves host:port, source, protocol,
    // capabilities, and error reason."
    expect(groups[0]?.alternates[0]?.errorReason).toBe("ECONNREFUSED");
    expect(groups[0]?.alternates[0]?.record.source).toBe("manual");
    expect(groups[0]?.alternates[0]?.record.kind).toBe("a2a");
  });

  test("same-name targets on different ports remain distinguishable in alternates", () => {
    // Brief scenario 4: "Same-name targets on different ports remain
    // distinguishable."
    const groups = groupDiscoveredTargets([
      target({ name: "tpm-agents-js", url: "http://127.0.0.1:9201" }),
      target({ name: "tpm-agents-js", url: "http://127.0.0.1:9301" }),
      target({ name: "tpm-agents-js", url: "http://10.0.0.5:9201" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.preferred.record.url).toBe("http://127.0.0.1:9201");
    expect(groups[0]?.alternates).toHaveLength(2);
    expect(groups[0]?.alternates.map((a) => a.record.url)).toEqual([
      "http://127.0.0.1:9301",
      "http://10.0.0.5:9201",
    ]);
  });

  test("multiple options compose: preferGateway + demoteOffline", () => {
    // Online-but-not-gateway, offline-gateway, offline-non-gateway, online-gateway
    // Expected preferred: online-gateway (gateway score -100, online +0 = -100)
    // Alternates ordering: online-non-gateway (+0), offline-gateway (-100+50=-50), offline-non-gateway (+50)
    // Stable sort tiebreak by index for equal scores.
    const groups = groupDiscoveredTargets(
      [
        target({
          name: "agent-x",
          url: "http://a.local",
          agent_id: "malar.local.agent-x",
          reachability: "online",
        }),
        target({
          name: "agent-x",
          url: "http://b.local",
          agent_id: "malar.local.gateway",
          reachability: "offline",
        }),
        target({
          name: "agent-x",
          url: "http://c.local",
          agent_id: "malar.local.agent-x",
          reachability: "offline",
        }),
        target({
          name: "agent-x",
          url: "http://d.local",
          agent_id: "malar.local.gateway",
          reachability: "online",
        }),
      ],
      { preferGateway: true, demoteOffline: true },
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.preferred.record.url).toBe("http://d.local");
    // alternates ordering by score then original index:
    // online-non-gateway (score 0) → comes first
    // offline-gateway (score -50) wait, lower is more preferred, so
    // -50 < 0, meaning offline-gateway is more preferred than online-non-gateway.
    // Actually re-read: gateway -100, offline +50, so offline-gateway = -50.
    // online-non-gateway = 0. So offline-gateway scores lower (more preferred).
    expect(groups[0]?.alternates.map((a) => a.record.url)).toEqual([
      "http://b.local", // offline-gateway = -50
      "http://a.local", // online-non-gateway = 0
      "http://c.local", // offline-non-gateway = +50
    ]);
  });

  test("empty input returns empty array", () => {
    expect(groupDiscoveredTargets([])).toEqual([]);
  });

  test("all options off (no opts) is pure pass-through grouping", () => {
    const targets: DiscoveredTarget[] = [
      target({ name: "a", reachability: "offline" }),
      target({ name: "b", reachability: "online" }),
    ];
    const groups = groupDiscoveredTargets(targets);
    expect(groups).toHaveLength(2);
    // Offline entry is NOT removed (default = preserve raw data).
    expect(groups[0]?.preferred.reachability).toBe("offline");
  });
});
