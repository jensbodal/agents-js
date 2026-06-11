/**
 * LT-10 — Cross-gateway registry sync (two gateways discover each other).
 *
 * Foundational e2e regression for the A2A cross-gateway peer-sync surface.
 * Auto-register (a gateway publishing its own (name, url) to the local
 * registry) is already exercised elsewhere; the gap this pins is the
 * *cross-gateway* half: gateway A learning gateway B's agent record over
 * the wire via the registry-sync protocol.
 *
 * What runs here is the real path, not a mock of it:
 *   - Two genuine gateways via `createGatewayTestServer` (HostA2AExecutor +
 *     ACPSessionController + UniversalA2AServer) on OS-assigned ports, each
 *     backed by the real `tests/mock-acp-agent.cjs` subprocess.
 *   - Each gateway gets its OWN registry file (isolated tmp dirs; never the
 *     shared default at ~/.agents-js/registry.json).
 *   - Gateway B auto-registers itself with `url` = B's *actual* gateway URL,
 *     and serves its peer-sync payload at the well-known endpoint via the
 *     real `createSyncEndpointHandler`.
 *   - Gateway A enables registry-sync through the production wrapper
 *     `startRegistrySync` (short interval). A is seeded with B as a known
 *     peer, so A's periodic pull fetches B's sync endpoint, filters/merges,
 *     and adopts B's record into A's registry with `source="sync"`.
 *
 * Assertion: within a bounded poll, A's registry file comes to contain B's
 * (name, url) record — provenance `source="sync"`, `gateway_id` = B's. Then,
 * to prove A learned a *reachable* peer (not just that one file copied a row
 * into another), we fetch B's agent card at the synced URL and expect 200 +
 * B's card name. That converts "a record propagated" into "A discovered a
 * live gateway it can reach."
 *
 * BOUNDARY (documented, not faked): `createGatewayTestServer` only exposes an
 * `additionalFetch` hook for the AG-UI endpoint, not for the registry-sync
 * handler. Rather than edit shared host test infra (which every sibling LT
 * example depends on), each gateway's `createSyncEndpointHandler` is served on
 * a small sidecar `Bun.serve` on its own OS-assigned port. The sync protocol
 * is transport-agnostic about which port the well-known endpoint lives on, so
 * this is the same wire path the production gateway mounts via `composeAdditionalFetch`
 * in apps/internal-gateway/main.ts — only the port differs. The gateways
 * themselves are real and load-bearing: B's advertised `url` is B's running
 * A2A server, and the card fetch proves it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  autoRegister,
  createSyncEndpointHandler,
  readAgentRegistryRecords,
  startRegistrySync,
} from "@agents-js/a2a-client/node";
import { createGatewayTestServer, type GatewayTestServerHandle } from "@agents-js/host/testing";

// The real external mock ACP agent (see tests/mock-acp-agent.cjs). Spawned as
// a genuine child by each gateway. From examples/registry-sync-smoke/tests the
// repo-root `tests/` dir is three levels up.
const MOCK_AGENT = resolve(import.meta.dir, "../../../tests/mock-acp-agent.cjs");

// Two real subprocess spawns + ACP handshakes + a polled cross-gateway sync
// are slower than the bun:test 5s default.
const TEST_TIMEOUT_MS = 30_000;

// Stable gateway identifiers — drive loop-prevention + provenance. Distinct so
// neither side mistakes the other's records for self-originated.
const GATEWAY_A_ID = "registry-sync-smoke-gateway-a";
const GATEWAY_B_ID = "registry-sync-smoke-gateway-b";
const GATEWAY_B_AGENT_NAME = "gateway-b-agent";

/** Sidecar HTTP server serving a gateway's registry-sync well-known endpoint. */
function serveSyncEndpoint(configPath: string): { url: string; stop: () => void } {
  const handler = createSyncEndpointHandler({ configPath });
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      // Fall through to 404 for anything that isn't the well-known sync path,
      // mirroring how the gateway's additionalFetch chain returns null then
      // lets the host server 404. Keeps the sidecar honest: only the sync
      // endpoint is reachable here.
      const res = await handler(req);
      return res ?? new Response("Not Found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/**
 * Poll `regA` until B's record is present (or the deadline passes). Bounded by
 * a real wall-clock deadline rather than a fixed sleep so the test is neither
 * flaky-fast nor needlessly slow. Returns the matching record or null.
 */
async function waitForPeerRecord(
  configPath: string,
  peerName: string,
  deadlineMs: number,
): Promise<Awaited<ReturnType<typeof readAgentRegistryRecords>>[number] | null> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const records = await readAgentRegistryRecords({ configPath });
    const hit = records.find((r) => r.name === peerName);
    if (hit) return hit;
    await Bun.sleep(50);
  }
  return null;
}

describe("registry-sync-smoke", () => {
  let gatewayA: GatewayTestServerHandle;
  let gatewayB: GatewayTestServerHandle;
  let syncSidecarA: { url: string; stop: () => void };
  let syncSidecarB: { url: string; stop: () => void };
  let registrySync: { stop: () => void } | undefined;
  let tmpRoot: string;
  let registryA: string;
  let registryB: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "registry-sync-smoke-"));
    registryA = join(tmpRoot, "registry-a.json");
    registryB = join(tmpRoot, "registry-b.json");

    // Two real gateways, each spawning the mock ACP agent as a child process.
    [gatewayA, gatewayB] = await Promise.all([
      createGatewayTestServer({ acpCommand: "node", acpArgs: [MOCK_AGENT] }),
      createGatewayTestServer({ acpCommand: "node", acpArgs: [MOCK_AGENT] }),
    ]);

    // Each gateway serves its sync endpoint from its own registry file on a
    // sidecar port (see BOUNDARY note in the file header).
    syncSidecarA = serveSyncEndpoint(registryA);
    syncSidecarB = serveSyncEndpoint(registryB);
  });

  afterEach(async () => {
    // Order matters: stop the periodic pull first so no sync fires mid-teardown
    // against an already-closed sidecar. Then sidecars, then the gateways
    // (which kill their ACP children), then remove tmp files.
    registrySync?.stop();
    syncSidecarA?.stop();
    syncSidecarB?.stop();
    await Promise.all([gatewayA?.stop(), gatewayB?.stop()]);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  // Intent: prove cross-gateway discovery end-to-end. Gateway B advertises its
  // real running A2A url; gateway A, with registry-sync enabled and B seeded as
  // a peer, pulls B's record over the wire and adopts it — then we confirm the
  // learned url is a live, reachable gateway.
  test(
    "gateway A discovers gateway B's agent via the A2A registry-sync pull-merge path",
    async () => {
      // --- B publishes itself. B's advertised url is its REAL gateway url, so
      // the record A eventually learns points at a reachable A2A server. ------
      const bRecord = await autoRegister({
        configPath: registryB,
        gatewayId: GATEWAY_B_ID,
        name: GATEWAY_B_AGENT_NAME,
        kind: "a2a",
        url: gatewayB.url,
      });
      expect(bRecord.source).toBe("auto-reg");
      expect(bRecord.url).toBe(gatewayB.url);

      // Sanity: B's sync endpoint serves exactly B's own record. This is the
      // payload A will pull. (Proves the served side independently of the pull.)
      const served = (await (
        await fetch(`${syncSidecarB.url}/.well-known/agents-js-registry.json`)
      ).json()) as { version: number; records: { name: string }[] };
      expect(served.version).toBe(2);
      expect(served.records.map((r) => r.name)).toEqual([GATEWAY_B_AGENT_NAME]);

      // --- A learns about B as a peer. startRegistrySync's periodic pull only
      // contacts peers already present as a2a records in A's registry, so seed
      // B's SYNC-ENDPOINT url here. (`syncFromPeer` appends the well-known path
      // to this base.) This is the "enable sync between them" wiring: A knows
      // where B's registry lives; it does not yet know B's agent record. ------
      await autoRegister({
        configPath: registryA,
        gatewayId: GATEWAY_B_ID,
        name: "gateway-b-peer",
        kind: "a2a",
        url: syncSidecarB.url,
      });

      // --- Enable registry-sync on A through the PRODUCTION wrapper. Short
      // interval so the bounded poll resolves quickly. Heartbeat disabled —
      // A re-publishing its own (name, url) is auto-register, not the cross-
      // gateway surface under test. ----------------------------------------
      registrySync = startRegistrySync({
        name: "gateway-a-agent",
        url: gatewayA.url,
        configPath: registryA,
        gatewayId: GATEWAY_A_ID,
        intervalMs: 100,
        heartbeatEnabled: false,
        // Quiet logger — the periodic pull logs per-sync lines we don't need.
        logger: { log() {}, warn() {}, error() {} },
      });

      // --- Bounded poll: A's registry must come to contain B's agent record. -
      const learned = await waitForPeerRecord(registryA, GATEWAY_B_AGENT_NAME, 10_000);
      if (!learned) throw new Error("gateway A never learned gateway B's record within the bound");

      // Provenance + payload: A adopted B's record over the wire (source=sync),
      // attributed to B's gateway, carrying B's real url — not the seed peer.
      expect(learned.kind).toBe("a2a");
      expect(learned.source).toBe("sync");
      expect(learned.gateway_id).toBe(GATEWAY_B_ID);
      expect(learned.url).toBe(gatewayB.url);

      // --- Reachability: the learned url is a LIVE gateway, not just a copied
      // row. Fetch B's agent card at the synced url and prove it answers. -----
      const cardRes = await fetch(`${learned.url}/.well-known/agent-card.json`);
      expect(cardRes.status).toBe(200);
      const card = (await cardRes.json()) as { name?: string };
      expect(card.name).toBe("gateway-test");
    },
    TEST_TIMEOUT_MS,
  );
});
