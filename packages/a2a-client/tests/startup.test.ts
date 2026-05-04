import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentRegistryRecords, startRegistrySync } from "../src/node.ts";
import type { AgentRegistryRecord } from "../src/registry.ts";

let tmpDir: string;
let configPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "startup-test-"));
  configPath = join(tmpDir, "registry.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("startRegistrySync", () => {
  test("auto-registers the local agent and writes to registry", async () => {
    const handle = startRegistrySync({
      name: "test-gateway",
      url: "http://localhost:9999",
      configPath,
      intervalMs: 0, // disable periodic sync
    });
    handle.stop();

    // Wait for fire-and-forget autoRegister to complete
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const records = await readAgentRegistryRecords({ configPath });
    expect(records).toHaveLength(1);
    const r = records[0];
    if (!r) throw new Error("record missing");
    expect(r.name).toBe("test-gateway");
    expect(r.url).toBe("http://localhost:9999");
    expect(r.source).toBe("auto-reg");
    expect(r.kind).toBe("a2a");
    expect(r.gateway_id).toBe(hostname());
  });

  test("syncHandler returns the registry payload for well-known GET", async () => {
    // Pre-populate the registry with an auto-reg record so it appears in the payload
    await writeFile(
      configPath,
      JSON.stringify({
        version: 2,
        agents: {
          "local-agent": {
            name: "local-agent",
            agent_id: "gw.local-agent",
            kind: "a2a",
            url: "http://local.test",
            gateway_id: "gw",
            source: "auto-reg",
            registered_at: "2026-04-24T00:00:00.000Z",
          },
        },
      }),
    );

    const handle = startRegistrySync({
      name: "test-gateway",
      url: "http://localhost:9999",
      configPath,
      intervalMs: 0,
    });

    try {
      const req = new Request("http://localhost:9999/.well-known/agents-js-registry.json");
      const response = await handle.syncHandler(req);
      expect(response).not.toBeNull();
      expect(response?.status).toBe(200);
      const body = (await response?.json()) as { version: number; records: AgentRegistryRecord[] };
      expect(body.version).toBe(2);
      // The auto-reg record is included; sync-sourced records are filtered
      expect(Array.isArray(body.records)).toBe(true);
      const localAgent = body.records.find((r) => r.name === "local-agent");
      expect(localAgent?.source).toBe("auto-reg");
    } finally {
      handle.stop();
    }
  });

  test("syncHandler returns null for non-matching paths", async () => {
    const handle = startRegistrySync({
      name: "test-gateway",
      url: "http://localhost:9999",
      configPath,
      intervalMs: 0,
    });

    try {
      const req = new Request("http://localhost:9999/agent");
      const response = await handle.syncHandler(req);
      expect(response).toBeNull();
    } finally {
      handle.stop();
    }
  });

  test("syncHandler returns null for POST to well-known path", async () => {
    const handle = startRegistrySync({
      name: "test-gateway",
      url: "http://localhost:9999",
      configPath,
      intervalMs: 0,
    });

    try {
      const req = new Request("http://localhost:9999/.well-known/agents-js-registry.json", {
        method: "POST",
      });
      const response = await handle.syncHandler(req);
      expect(response).toBeNull();
    } finally {
      handle.stop();
    }
  });

  test("stop() clears the interval without throwing", () => {
    const handle = startRegistrySync({
      name: "test-gateway",
      url: "http://localhost:9999",
      configPath,
      intervalMs: 100,
    });

    expect(() => handle.stop()).not.toThrow();
    // Calling stop twice should also be safe
    expect(() => handle.stop()).not.toThrow();
  });

  test("periodic sync pulls from a2a-kind peers and skips self-gateway records", async () => {
    // Set up a fake peer registry HTTP server
    const peerRecords: AgentRegistryRecord[] = [
      {
        name: "remote-agent",
        agent_id: "remote-gw.remote-agent",
        kind: "a2a",
        url: "http://remote.test",
        gateway_id: "remote-gw",
        source: "auto-reg",
        registered_at: "2026-04-24T00:00:00.000Z",
      },
    ];

    const peerServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/.well-known/agents-js-registry.json") {
          return new Response(JSON.stringify({ version: 2, records: peerRecords }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    // Pre-populate registry with a peer entry so startRegistrySync will sync from it
    const peerUrl = `http://localhost:${peerServer.port}`;
    const selfGatewayId = hostname();
    await writeFile(
      configPath,
      JSON.stringify({
        version: 2,
        agents: {
          peer: {
            name: "peer",
            agent_id: "remote-gw.peer",
            kind: "a2a",
            url: peerUrl,
            gateway_id: "remote-gw",
            source: "auto-reg",
            registered_at: "2026-04-24T00:00:00.000Z",
          },
        },
      }),
    );

    const handle = startRegistrySync({
      name: "test-gateway",
      url: "http://localhost:9999",
      configPath,
      intervalMs: 50, // short for test
      gatewayId: selfGatewayId,
    });

    try {
      // Wait for at least one sync tick
      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      const records = await readAgentRegistryRecords({ configPath });
      const remoteAgent = records.find((r) => r.name === "remote-agent");
      expect(remoteAgent).toBeDefined();
      expect(remoteAgent?.source).toBe("sync");
    } finally {
      handle.stop();
      peerServer.stop(true);
    }
  });
});
