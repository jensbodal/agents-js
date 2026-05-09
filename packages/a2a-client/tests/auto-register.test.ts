import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { autoRegister, readAgentRegistryRecords } from "../src/node.ts";

let tmpDir: string;
let configPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "auto-reg-test-"));
  configPath = join(tmpDir, "registry.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("readAgentRegistryRecords (v1 → v2 migration)", () => {
  test("synthesizes provenance fields for v1 records on read", async () => {
    // v1 file: no version field, transport-only entries.
    await writeFile(
      configPath,
      JSON.stringify({
        agents: {
          "legacy-a2a": { kind: "a2a", url: "http://legacy.test" },
        },
      }),
    );
    // Pin mtime so registered_at is deterministic.
    const pinned = new Date("2026-04-20T12:00:00Z");
    await utimes(configPath, pinned, pinned);

    const records = await readAgentRegistryRecords({ configPath });
    expect(records).toHaveLength(1);
    const r = records[0];
    if (!r) throw new Error("record missing");
    expect(r.name).toBe("legacy-a2a");
    expect(r.kind).toBe("a2a");
    expect(r.url).toBe("http://legacy.test");
    expect(r.gateway_id).toBe(hostname());
    expect(r.agent_id).toBe(`${hostname()}.legacy-a2a`);
    expect(r.source).toBe("manual");
    expect(r.registered_at).toBe(pinned.toISOString());
  });

  test("backfills absent actor_type to 'machine'", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        agents: {
          "legacy-acp": { kind: "acp", harness: "claude" },
        },
      }),
    );
    const records = await readAgentRegistryRecords({ configPath });
    const r = records[0];
    if (!r) throw new Error("record missing");
    expect(r.actor_type).toBe("machine");
  });

  test("does not rewrite the file on read", async () => {
    const original = JSON.stringify({
      agents: { alpha: { kind: "a2a", url: "http://alpha.test" } },
    });
    await writeFile(configPath, original);
    await readAgentRegistryRecords({ configPath });
    const after = await readFile(configPath, "utf-8");
    expect(after).toBe(original);
  });

  test("preserves existing v2 provenance fields without overriding", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        version: 2,
        agents: {
          "already-v2": {
            name: "already-v2",
            agent_id: "someGateway.already-v2",
            kind: "a2a",
            url: "http://x.test",
            actor_type: "human",
            gateway_id: "someGateway",
            source: "auto-reg",
            registered_at: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    const records = await readAgentRegistryRecords({ configPath });
    const r = records[0];
    if (!r) throw new Error("record missing");
    expect(r.gateway_id).toBe("someGateway");
    expect(r.agent_id).toBe("someGateway.already-v2");
    expect(r.source).toBe("auto-reg");
    expect(r.actor_type).toBe("human");
    expect(r.registered_at).toBe("2026-01-01T00:00:00.000Z");
  });

  test("returns empty array when the file is missing (fails open)", async () => {
    const records = await readAgentRegistryRecords({
      configPath: join(tmpDir, "missing.json"),
    });
    expect(records).toEqual([]);
  });
});

describe("autoRegister", () => {
  test("writes a v2 a2a record with synthesized provenance", async () => {
    const record = await autoRegister({
      configPath,
      name: "compiler",
      kind: "a2a",
      url: "http://compiler.test",
      gatewayId: "mac",
      registeredAt: "2026-04-23T22:05:00.000Z",
    });
    expect(record.agent_id).toBe("mac.compiler");
    expect(record.source).toBe("auto-reg");
    expect(record.actor_type).toBe("machine");
    expect(record.gateway_id).toBe("mac");
    expect(record.url).toBe("http://compiler.test");
    expect(record.registered_at).toBe("2026-04-23T22:05:00.000Z");

    const onDisk = JSON.parse(await readFile(configPath, "utf-8"));
    expect(onDisk.version).toBe(2);
    expect(onDisk.agents.compiler.kind).toBe("a2a");
    expect(onDisk.agents.compiler.source).toBe("auto-reg");
    expect(onDisk.agents.compiler.gateway_id).toBe("mac");
    expect(onDisk.agents.compiler.agent_id).toBe("mac.compiler");
  });

  test("writes a v2 acp record with spawn-config fields", async () => {
    await autoRegister({
      configPath,
      name: "reviewer",
      kind: "acp",
      harness: "claude",
      command: "claude-agent-acp",
      args: ["--debug"],
      env: { FOO: "bar" },
      workspaceFlag: "--cwd",
      gatewayId: "mac",
    });
    const records = await readAgentRegistryRecords({ configPath });
    const r = records[0];
    if (!r) throw new Error("record missing");
    expect(r.kind).toBe("acp");
    expect(r.harness).toBe("claude");
    expect(r.command).toBe("claude-agent-acp");
    expect(r.args).toEqual(["--debug"]);
    expect(r.env).toEqual({ FOO: "bar" });
    expect(r.workspaceFlag).toBe("--cwd");
  });

  test("is idempotent — calling twice with the same name replaces, not duplicates", async () => {
    await autoRegister({
      configPath,
      name: "same",
      kind: "a2a",
      url: "http://first.test",
      gatewayId: "mac",
    });
    await autoRegister({
      configPath,
      name: "same",
      kind: "a2a",
      url: "http://second.test",
      gatewayId: "mac",
    });
    const records = await readAgentRegistryRecords({ configPath });
    expect(records).toHaveLength(1);
    expect(records[0]?.url).toBe("http://second.test");
  });

  test("preserves other agents when registering a new one", async () => {
    await autoRegister({
      configPath,
      name: "alpha",
      kind: "a2a",
      url: "http://alpha.test",
      gatewayId: "mac",
    });
    await autoRegister({
      configPath,
      name: "beta",
      kind: "a2a",
      url: "http://beta.test",
      gatewayId: "mac",
    });
    const records = await readAgentRegistryRecords({ configPath });
    expect(records).toHaveLength(2);
    const names = records.map((r) => r.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });

  test("defaults actor_type to 'machine' and emits protocol_version when provided", async () => {
    const record = await autoRegister({
      configPath,
      name: "review-agent",
      kind: "a2a",
      url: "http://gateway.test:8080/a2a",
      gatewayId: "mac",
      protocolVersion: "0.2.1",
    });
    expect(record.actor_type).toBe("machine");
    expect(record.protocol_version).toBe("0.2.1");
  });

  test("leaves preferred_gateway_id unset by default", async () => {
    const record = await autoRegister({
      configPath,
      name: "a",
      kind: "a2a",
      url: "http://a.test",
      gatewayId: "mac",
    });
    expect(record.preferred_gateway_id).toBeUndefined();
  });
});
