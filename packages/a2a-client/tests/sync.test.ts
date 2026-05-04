import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditEmitter } from "@agents-js/a2a/audit";
import {
  autoRegister,
  buildSyncPayload,
  createSyncEndpointHandler,
  fetchPeerRecords,
  mergeRecords,
  PeerSyncError,
  readAgentRegistryRecords,
  syncFromPeer,
} from "../src/node.ts";
import type { AgentRegistryRecord } from "../src/registry.ts";

/**
 * Sync merge-matrix coverage.
 *
 * Six branches are covered:
 *   1. first-sync (add path)
 *   2. re-sync no-op (same gateway, same registered_at)
 *   3. peer-updated (same gateway, peer registered_at newer)
 *   4. preferred_gateway_id conflict resolution
 *   5. last-writer-wins conflict resolution
 *   6. loop prevention (sync'd record does not re-propagate)
 *
 * Tests run against both the pure merge function (white-box, no I/O)
 * and the full syncFromPeer pipeline (black-box, HTTP + disk). That
 * gives us fast unit coverage of every branch AND end-to-end proof
 * that fetch → merge → write composes correctly.
 */

let tmpDir: string;
let configPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "sync-test-"));
  configPath = join(tmpDir, "registry.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Build a fetch mock that serves `payload` at the well-known path for `peerUrl`. */
function createSyncMockFetch(
  peerUrl: string,
  payload: unknown,
  options: { status?: number } = {},
): typeof fetch {
  const status = options.status ?? 200;
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const expected = `${peerUrl.replace(/\/+$/, "")}/.well-known/agents-js-registry.json`;
    if (url === expected) {
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
}

/** Minimal record builder — only fields the merge branches care about. */
function rec(
  overrides: Partial<AgentRegistryRecord> & Pick<AgentRegistryRecord, "name">,
): AgentRegistryRecord {
  const gatewayId = overrides.gateway_id ?? "peerA";
  const defaults: AgentRegistryRecord = {
    name: overrides.name,
    agent_id: `${gatewayId}.${overrides.name}`,
    kind: "a2a",
    gateway_id: gatewayId,
    source: "auto-reg",
    registered_at: "2026-04-23T12:00:00.000Z",
  };
  return { ...defaults, ...overrides };
}

describe("mergeRecords (pure merge matrix)", () => {
  // Branch 1 — first-sync. WHY: empty local + non-empty peer should copy
  // the peer record in with source flipped to "sync" and last_synced_at
  // stamped. gateway_id must stay the peer's (it's the origin), not ours.
  test("branch 1 — first-sync: new peer record added with source=sync", () => {
    const peer = [rec({ name: "alpha", gateway_id: "peerA", url: "http://alpha.test" })];
    const { merged, actions } = mergeRecords([], peer, {
      localGatewayId: "localM",
      now: "2026-04-23T13:00:00.000Z",
    });
    expect(Object.keys(merged)).toEqual(["alpha"]);
    const stored = merged.alpha;
    if (!stored) throw new Error("record missing");
    expect(stored.source).toBe("sync");
    expect(stored.gateway_id).toBe("peerA"); // origin preserved
    expect(stored.last_synced_at).toBe("2026-04-23T13:00:00.000Z");
    expect(actions).toEqual([{ kind: "added", name: "alpha", agent_id: "peerA.alpha" }]);
  });

  // Branch 2 — re-sync no-op. WHY: we already received peerA's version
  // of "alpha" last sync; peer re-sends the same record. No fields
  // change, but last_synced_at should still refresh so stale-detection
  // later can tell "haven't talked in a while" from "haven't changed".
  test("branch 2 — re-sync no-op: same gateway_id + same registered_at refreshes only last_synced_at", () => {
    const original: AgentRegistryRecord = {
      ...rec({
        name: "alpha",
        gateway_id: "peerA",
        url: "http://alpha.test",
        registered_at: "2026-04-23T12:00:00.000Z",
      }),
      source: "sync",
      last_synced_at: "2026-04-23T12:05:00.000Z",
    };
    const peer = [rec({ name: "alpha", gateway_id: "peerA", url: "http://alpha.test" })];
    const { merged, actions } = mergeRecords([original], peer, {
      localGatewayId: "localM",
      now: "2026-04-23T13:00:00.000Z",
    });
    const stored = merged.alpha;
    if (!stored) throw new Error("record missing");
    expect(stored.last_synced_at).toBe("2026-04-23T13:00:00.000Z");
    expect(stored.url).toBe("http://alpha.test");
    expect(actions[0]).toEqual({
      kind: "unchanged",
      name: "alpha",
      agent_id: "peerA.alpha",
      reason: "same-gateway-local-newer",
    });
  });

  // Branch 3 — peer-updated. WHY: peerA re-registered "alpha" at a later
  // timestamp (e.g. its URL changed). Peer is authoritative over its own
  // records so we must overwrite; source stays "sync" and last_synced_at
  // stamps. gateway_id remains "peerA" (it's still peerA's record, just
  // a newer version of it).
  test("branch 3 — peer-updated: newer peer registered_at overwrites local", () => {
    const local: AgentRegistryRecord = {
      ...rec({
        name: "alpha",
        gateway_id: "peerA",
        url: "http://old.test",
        registered_at: "2026-04-23T12:00:00.000Z",
      }),
      source: "sync",
    };
    const peer = [
      rec({
        name: "alpha",
        gateway_id: "peerA",
        url: "http://new.test",
        registered_at: "2026-04-23T14:00:00.000Z",
      }),
    ];
    const { merged, actions } = mergeRecords([local], peer, {
      localGatewayId: "localM",
      now: "2026-04-23T15:00:00.000Z",
    });
    const stored = merged.alpha;
    if (!stored) throw new Error("record missing");
    expect(stored.url).toBe("http://new.test");
    expect(stored.source).toBe("sync");
    expect(stored.registered_at).toBe("2026-04-23T14:00:00.000Z");
    expect(stored.last_synced_at).toBe("2026-04-23T15:00:00.000Z");
    expect(actions[0]).toEqual({
      kind: "updated",
      name: "alpha",
      agent_id: "peerA.alpha",
      reason: "peer-newer",
    });
  });

  // Branch 4a — preferred_gateway_id favors local. WHY: two gateways
  // both have a local "alpha"; an operator marked peerA as preferred on
  // the local side. Peer's record comes from peerB. Preference resolves
  // to peerA, which matches NEITHER — fall through to LWW. We test the
  // direct-local-match case instead to pin the "preferred=local wins"
  // branch cleanly.
  test("branch 4 — preferred_gateway_id matches local gateway, local wins and peer ignored", () => {
    const local: AgentRegistryRecord = {
      ...rec({
        name: "alpha",
        gateway_id: "localM",
        url: "http://local.test",
        registered_at: "2026-04-20T00:00:00.000Z",
      }),
      source: "auto-reg",
      preferred_gateway_id: "localM",
    };
    const peer = [
      rec({
        name: "alpha",
        gateway_id: "peerB",
        url: "http://peer.test",
        registered_at: "2026-04-23T00:00:00.000Z", // newer — would win under LWW
      }),
    ];
    const { merged, actions } = mergeRecords([local], peer, {
      localGatewayId: "localM",
      now: "2026-04-23T15:00:00.000Z",
    });
    const stored = merged.alpha;
    if (!stored) throw new Error("record missing");
    expect(stored.gateway_id).toBe("localM");
    expect(stored.url).toBe("http://local.test");
    // preferred-local action + a conflict-resolved record next to it
    const kinds = actions.map((a) => a.kind);
    expect(kinds).toContain("unchanged");
    expect(kinds).toContain("conflict-resolved");
    const conflict = actions.find((a) => a.kind === "conflict-resolved");
    if (!conflict || conflict.kind !== "conflict-resolved") throw new Error("conflict missing");
    expect(conflict.resolution).toBe("preferred_gateway_id");
    expect(conflict.winner_gateway_id).toBe("localM");
  });

  // Branch 4b — preferred_gateway_id favors peer. WHY: local previously
  // auto-registered "alpha"; operator later set preferred_gateway_id to
  // peerB on one of the records (peer-side in this test). Peer wins
  // even when local's registered_at is newer.
  test("branch 4 — preferred_gateway_id matches peer gateway, peer wins over newer local", () => {
    const local: AgentRegistryRecord = {
      ...rec({
        name: "alpha",
        gateway_id: "localM",
        url: "http://local.test",
        registered_at: "2026-04-30T00:00:00.000Z", // newer — would win under LWW
      }),
      source: "auto-reg",
    };
    const peer = [
      {
        ...rec({
          name: "alpha",
          gateway_id: "peerB",
          url: "http://peer.test",
          registered_at: "2026-04-20T00:00:00.000Z",
        }),
        preferred_gateway_id: "peerB",
      },
    ];
    const { merged } = mergeRecords([local], peer, {
      localGatewayId: "localM",
      now: "2026-04-30T12:00:00.000Z",
    });
    const stored = merged.alpha;
    if (!stored) throw new Error("record missing");
    expect(stored.gateway_id).toBe("peerB");
    expect(stored.url).toBe("http://peer.test");
    expect(stored.source).toBe("sync");
  });

  // Branch 5 — last-writer-wins. WHY: two gateways each registered
  // "alpha" independently, neither has preferred_gateway_id set. Peer's
  // registered_at is later, so peer wins. Conflict is logged but no
  // preference was expressed, so resolution=last-writer-wins.
  test("branch 5 — last-writer-wins: no preferred_gateway_id, newer registered_at wins", () => {
    const local: AgentRegistryRecord = {
      ...rec({
        name: "alpha",
        gateway_id: "localM",
        url: "http://local.test",
        registered_at: "2026-04-20T00:00:00.000Z",
      }),
      source: "auto-reg",
    };
    const peer = [
      rec({
        name: "alpha",
        gateway_id: "peerB",
        url: "http://peer.test",
        registered_at: "2026-04-25T00:00:00.000Z",
      }),
    ];
    const { merged, actions } = mergeRecords([local], peer, {
      localGatewayId: "localM",
      now: "2026-04-25T12:00:00.000Z",
    });
    const stored = merged.alpha;
    if (!stored) throw new Error("record missing");
    expect(stored.gateway_id).toBe("peerB"); // peer won
    const conflict = actions.find((a) => a.kind === "conflict-resolved");
    if (!conflict || conflict.kind !== "conflict-resolved") throw new Error("conflict missing");
    expect(conflict.resolution).toBe("last-writer-wins");
    expect(conflict.winner_gateway_id).toBe("peerB");
  });

  // Branch 6 — loop prevention. WHY: peer is serving us back a record
  // we originated (peer.gateway_id === localGatewayId). This would
  // only happen if peer misbehaves or the send-side filter was bypassed;
  // receive-side drops it anyway. Defense in depth.
  test("branch 6 — loop prevention: peer record whose gateway_id is local-self is skipped", () => {
    const peer = [rec({ name: "alpha", gateway_id: "localM", url: "http://mine.test" })];
    const { merged, actions } = mergeRecords([], peer, {
      localGatewayId: "localM",
      now: "2026-04-25T12:00:00.000Z",
    });
    expect(merged).toEqual({});
    expect(actions).toEqual([{ kind: "skipped-loop", name: "alpha", agent_id: "localM.alpha" }]);
  });

  // Preferred disagreement: both records have preferred_gateway_id but
  // they point at different gateways. Falls through to LWW. Verify
  // the fallback path explicitly — prevents silent bias.
  test("preferred_gateway_id disagreement falls through to last-writer-wins", () => {
    const local: AgentRegistryRecord = {
      ...rec({
        name: "alpha",
        gateway_id: "localM",
        registered_at: "2026-04-20T00:00:00.000Z",
      }),
      source: "auto-reg",
      preferred_gateway_id: "localM",
    };
    const peer = [
      {
        ...rec({
          name: "alpha",
          gateway_id: "peerB",
          registered_at: "2026-04-25T00:00:00.000Z",
        }),
        preferred_gateway_id: "peerB",
      },
    ];
    const { merged, actions } = mergeRecords([local], peer, {
      localGatewayId: "localM",
      now: "2026-04-25T12:00:00.000Z",
    });
    const stored = merged.alpha;
    if (!stored) throw new Error("record missing");
    expect(stored.gateway_id).toBe("peerB"); // LWW picks peer
    const conflict = actions.find((a) => a.kind === "conflict-resolved");
    if (!conflict || conflict.kind !== "conflict-resolved") throw new Error("conflict missing");
    expect(conflict.resolution).toBe("last-writer-wins");
  });
});

describe("buildSyncPayload (send-side loop prevention)", () => {
  test("filters out source=sync records — only serves what this gateway originated", () => {
    const records: AgentRegistryRecord[] = [
      rec({ name: "own", gateway_id: "localM", source: "auto-reg" }),
      rec({ name: "also-own", gateway_id: "localM", source: "manual" }),
      {
        ...rec({ name: "received-from-peer", gateway_id: "peerA", source: "sync" }),
        last_synced_at: "2026-04-23T12:00:00.000Z",
      },
    ];
    const payload = buildSyncPayload(records);
    expect(payload.version).toBe(2);
    expect(payload.records.map((r) => r.name).sort()).toEqual(["also-own", "own"]);
  });
});

describe("buildSyncPayload (schema-driven projection)", () => {
  test("strips ACP launch fields if they ended up on an A2A in-memory record", () => {
    // The kind=acp filter is necessary but not sufficient — a future
    // code path (or a corrupted in-memory state) could attach
    // `command`/`args`/`env`/`workspaceFlag` to an A2A record. The
    // wire schema's `.strip()` mode is the load-bearing guarantee
    // that those fields cannot reach the served payload.
    const smuggled = {
      ...rec({ name: "smuggled-a2a", gateway_id: "localM", url: "http://s.test" }),
      command: "/bin/leaked",
      args: ["--exfiltrate"],
      env: { SECRET: "x" },
      workspaceFlag: "--cwd",
    } as unknown as AgentRegistryRecord;
    const payload = buildSyncPayload([smuggled]);
    expect(payload.records).toHaveLength(1);
    const served = payload.records[0] as Record<string, unknown> | undefined;
    expect(served?.name).toBe("smuggled-a2a");
    expect(served?.command).toBeUndefined();
    expect(served?.args).toBeUndefined();
    expect(served?.env).toBeUndefined();
    expect(served?.workspaceFlag).toBeUndefined();
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("/bin/leaked");
    expect(serialized).not.toContain("SECRET");
  });
});

describe("buildSyncPayload (A2A-only restriction)", () => {
  test("filters out kind=acp records so launch fields cannot leak", () => {
    const records: AgentRegistryRecord[] = [
      rec({ name: "remote-a2a", gateway_id: "localM", source: "auto-reg" }),
      {
        name: "local-acp",
        agent_id: "localM.local-acp",
        kind: "acp",
        gateway_id: "localM",
        source: "manual",
        registered_at: "2026-04-23T12:00:00.000Z",
        harness: "claude",
        command: "/bin/false",
        args: ["--something"],
        env: { SECRET: "x" },
        workspaceFlag: "--cwd",
      },
    ];
    const payload = buildSyncPayload(records);
    expect(payload.records.map((r) => r.name)).toEqual(["remote-a2a"]);
    // Defense in depth — the served wire must not mention any ACP launch
    // field even structurally; serialize and grep.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("local-acp");
    expect(serialized).not.toContain("/bin/false");
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("workspaceFlag");
  });
});

describe("fetchPeerRecords (A2A-only restriction)", () => {
  test("drops kind=acp wire records and any launch fields they carry", async () => {
    const peerUrl = "http://peerA.test:8080";
    const wirePayload = {
      version: 2,
      records: [
        rec({ name: "valid-a2a", gateway_id: "peerA", url: "http://va.test" }),
        {
          // A malicious peer attempting to smuggle launch material.
          name: "leaked-acp",
          agent_id: "peerA.leaked-acp",
          kind: "acp",
          gateway_id: "peerA",
          source: "manual",
          registered_at: "2026-04-23T12:00:00.000Z",
          harness: "claude",
          command: "/bin/leaked",
          args: ["--exfiltrate"],
          env: { SECRET: "x" },
          workspaceFlag: "--cwd",
        },
      ],
    };
    const records = await fetchPeerRecords({
      peerUrl,
      fetchImpl: createSyncMockFetch(peerUrl, wirePayload),
    });
    expect(records.map((r) => r.name)).toEqual(["valid-a2a"]);
    // The accepted record must not carry launch fields even if a peer
    // were to attach them to an A2A record (defense in depth).
    const accepted = records[0] as Record<string, unknown> | undefined;
    expect(accepted?.command).toBeUndefined();
    expect(accepted?.args).toBeUndefined();
    expect(accepted?.env).toBeUndefined();
    expect(accepted?.workspaceFlag).toBeUndefined();
  });

  test("ignores launch fields attached to an A2A wire record", async () => {
    const peerUrl = "http://peerA.test:8080";
    // Hostile peer attaches launch fields to an a2a record (where they
    // are nonsensical) hoping the receiver merges them anyway.
    const wirePayload = {
      version: 2,
      records: [
        {
          ...rec({ name: "smuggled", gateway_id: "peerA", url: "http://s.test" }),
          command: "/bin/leaked",
          args: ["--exfiltrate"],
          env: { SECRET: "x" },
          workspaceFlag: "--cwd",
        },
      ],
    };
    const records = await fetchPeerRecords({
      peerUrl,
      fetchImpl: createSyncMockFetch(peerUrl, wirePayload),
    });
    expect(records).toHaveLength(1);
    const accepted = records[0] as Record<string, unknown> | undefined;
    expect(accepted?.name).toBe("smuggled");
    expect(accepted?.command).toBeUndefined();
    expect(accepted?.args).toBeUndefined();
    expect(accepted?.env).toBeUndefined();
    expect(accepted?.workspaceFlag).toBeUndefined();
  });
});

describe("fetchPeerRecords", () => {
  test("GETs the well-known path and returns the decoded records", async () => {
    const peerUrl = "http://peerA.test:8080";
    const wirePayload = {
      version: 2,
      records: [rec({ name: "alpha", gateway_id: "peerA", url: "http://alpha.test" })],
    };
    const records = await fetchPeerRecords({
      peerUrl,
      fetchImpl: createSyncMockFetch(peerUrl, wirePayload),
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe("alpha");
  });

  test("throws PeerSyncError on non-200", async () => {
    const peerUrl = "http://peerA.test:8080";
    const fetchImpl = createSyncMockFetch(peerUrl, {}, { status: 500 });
    await expect(fetchPeerRecords({ peerUrl, fetchImpl })).rejects.toBeInstanceOf(PeerSyncError);
  });

  test("throws PeerSyncError on version mismatch", async () => {
    const peerUrl = "http://peerA.test:8080";
    const fetchImpl = createSyncMockFetch(peerUrl, { version: 1, records: [] });
    await expect(fetchPeerRecords({ peerUrl, fetchImpl })).rejects.toBeInstanceOf(PeerSyncError);
  });

  test("skips malformed records rather than failing the batch", async () => {
    const peerUrl = "http://peerA.test:8080";
    const wirePayload = {
      version: 2,
      records: [
        rec({ name: "valid", gateway_id: "peerA", url: "http://v.test" }),
        { name: "missing-gateway" }, // malformed
        42, // outright wrong
      ],
    };
    const records = await fetchPeerRecords({
      peerUrl,
      fetchImpl: createSyncMockFetch(peerUrl, wirePayload),
    });
    expect(records.map((r) => r.name)).toEqual(["valid"]);
  });
});

describe("syncFromPeer (end-to-end pipeline)", () => {
  test("first-sync writes peer records to local registry with source=sync", async () => {
    const audit = createAuditEmitter({ logger: { log: () => {} } });
    const peerUrl = "http://peerA.test:8080";
    const wirePayload = {
      version: 2,
      records: [rec({ name: "alpha", gateway_id: "peerA", url: "http://alpha.test" })],
    };
    const summary = await syncFromPeer({
      peerUrl,
      configPath,
      localGatewayId: "localM",
      now: () => new Date("2026-04-23T15:00:00.000Z"),
      fetchImpl: createSyncMockFetch(peerUrl, wirePayload),
      audit,
    });
    expect(summary.added).toEqual(["alpha"]);
    expect(summary.peerRecordsReceived).toBe(1);

    const onDisk = await readAgentRegistryRecords({ configPath });
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]?.source).toBe("sync");
    expect(onDisk[0]?.last_synced_at).toBe("2026-04-23T15:00:00.000Z");
    expect(audit.recent().map((event) => event.kind)).toEqual([
      "registry-sync-fetched",
      "registry-sync-merged",
    ]);
    const serializedAudit = JSON.stringify(audit.recent());
    expect(serializedAudit).not.toContain("command");
    expect(serializedAudit).not.toContain("env");
  });

  test("preserves locally-authored records when merging peer records", async () => {
    // Seed local with our own auto-reg record first.
    await autoRegister({
      configPath,
      name: "local-service",
      kind: "a2a",
      url: "http://local.test",
      gatewayId: "localM",
    });

    const peerUrl = "http://peerA.test:8080";
    const wirePayload = {
      version: 2,
      records: [rec({ name: "peer-service", gateway_id: "peerA", url: "http://peer.test" })],
    };
    await syncFromPeer({
      peerUrl,
      configPath,
      localGatewayId: "localM",
      now: () => new Date("2026-04-23T15:00:00.000Z"),
      fetchImpl: createSyncMockFetch(peerUrl, wirePayload),
    });

    const onDisk = await readAgentRegistryRecords({ configPath });
    const names = onDisk.map((r) => r.name).sort();
    expect(names).toEqual(["local-service", "peer-service"]);
    const localEntry = onDisk.find((r) => r.name === "local-service");
    expect(localEntry?.source).toBe("auto-reg"); // unchanged
  });

  test("loop prevention end-to-end: peer serves back our record, we drop it", async () => {
    await autoRegister({
      configPath,
      name: "mine",
      kind: "a2a",
      url: "http://mine.test",
      gatewayId: "localM",
    });
    const peerUrl = "http://peerA.test:8080";
    // Peer is misbehaving — includes one of OUR records in its payload.
    const wirePayload = {
      version: 2,
      records: [rec({ name: "mine", gateway_id: "localM", url: "http://peer-reserved.test" })],
    };
    const summary = await syncFromPeer({
      peerUrl,
      configPath,
      localGatewayId: "localM",
      now: () => new Date("2026-04-23T15:00:00.000Z"),
      fetchImpl: createSyncMockFetch(peerUrl, wirePayload),
    });
    expect(summary.skippedLoops).toEqual(["mine"]);

    // Our record is untouched.
    const onDisk = await readAgentRegistryRecords({ configPath });
    const mine = onDisk.find((r) => r.name === "mine");
    expect(mine?.url).toBe("http://mine.test");
    expect(mine?.source).toBe("auto-reg");
  });
});

describe("createSyncEndpointHandler (HTTP surface)", () => {
  test("GET /.well-known/agents-js-registry.json returns payload filtered to source != sync", async () => {
    const audit = createAuditEmitter({ logger: { log: () => {} } });
    await autoRegister({
      configPath,
      name: "own",
      kind: "a2a",
      url: "http://own.test",
      gatewayId: "localM",
    });
    // Simulate a previously-sync'd record from a peer.
    const existing = await readAgentRegistryRecords({ configPath });
    const merged: Record<string, unknown> = {};
    for (const r of existing) merged[r.name] = r;
    merged.received = {
      name: "received",
      agent_id: "peerA.received",
      kind: "a2a",
      url: "http://received.test",
      gateway_id: "peerA",
      source: "sync",
      registered_at: "2026-04-23T10:00:00.000Z",
      last_synced_at: "2026-04-23T11:00:00.000Z",
    };
    await writeFile(configPath, JSON.stringify({ version: 2, agents: merged }, null, 2));

    const handler = createSyncEndpointHandler({ configPath, audit });
    const res = await handler(new Request("http://localhost/.well-known/agents-js-registry.json"));
    expect(res).not.toBeNull();
    if (!res) throw new Error("res null");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: number; records: AgentRegistryRecord[] };
    expect(body.version).toBe(2);
    const names = body.records.map((r) => r.name).sort();
    expect(names).toEqual(["own"]); // "received" filtered out (source=sync)
    const served = audit.recent()[0];
    expect(served?.kind).toBe("registry-sync-served");
    expect((served as { recordCount?: number }).recordCount).toBe(1);
    expect((served as { totalRecordCount?: number }).totalRecordCount).toBe(2);
  });

  test("non-matching path returns null (falls through to host fetch handler)", async () => {
    const handler = createSyncEndpointHandler({ configPath });
    const res = await handler(new Request("http://localhost/some-other-path"));
    expect(res).toBeNull();
  });

  test("non-GET method returns null (only GET is the sync surface)", async () => {
    const handler = createSyncEndpointHandler({ configPath });
    const res = await handler(
      new Request("http://localhost/.well-known/agents-js-registry.json", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res).toBeNull();
  });
});

// Integration-style: two temp registries, one serves, one pulls. Uses
// Bun.serve on a real ephemeral port so the round-trip exercises actual
// HTTP headers + URL parsing, not just the handler in isolation.
describe("syncFromPeer integration with a live Bun.serve", () => {
  test("round-trip: gateway B pulls from gateway A", async () => {
    const configA = join(tmpDir, "gatewayA.json");
    const configB = join(tmpDir, "gatewayB.json");

    // Gateway A: one auto-reg'd record, one imagined sync'd-from-C record
    // that must NOT leak to B.
    await autoRegister({
      configPath: configA,
      name: "a-service",
      kind: "a2a",
      url: "http://a-service.test",
      gatewayId: "gatewayA",
    });
    const aExisting = await readAgentRegistryRecords({ configPath: configA });
    const aMerged: Record<string, unknown> = {};
    for (const r of aExisting) aMerged[r.name] = r;
    aMerged["ghost-from-c"] = {
      name: "ghost-from-c",
      agent_id: "gatewayC.ghost-from-c",
      kind: "a2a",
      url: "http://c.test",
      gateway_id: "gatewayC",
      source: "sync",
      registered_at: "2026-04-22T00:00:00.000Z",
      last_synced_at: "2026-04-22T12:00:00.000Z",
    };
    await writeFile(configA, JSON.stringify({ version: 2, agents: aMerged }, null, 2));

    const handlerA = createSyncEndpointHandler({ configPath: configA });
    const serverA = Bun.serve({
      port: 0,
      async fetch(req) {
        const res = await handlerA(req);
        return res ?? new Response("Not Found", { status: 404 });
      },
    });
    try {
      const peerUrl = `http://127.0.0.1:${serverA.port}`;
      const summary = await syncFromPeer({
        peerUrl,
        configPath: configB,
        localGatewayId: "gatewayB",
        now: () => new Date("2026-04-23T15:00:00.000Z"),
      });
      // Only "a-service" should propagate. The sync'd-from-C record is
      // filtered by A's send-side; B never sees it.
      expect(summary.added).toEqual(["a-service"]);
      expect(summary.peerRecordsReceived).toBe(1);

      const onDiskB = await readAgentRegistryRecords({ configPath: configB });
      const names = onDiskB.map((r) => r.name).sort();
      expect(names).toEqual(["a-service"]);
    } finally {
      serverA.stop(true);
    }
  });
});
