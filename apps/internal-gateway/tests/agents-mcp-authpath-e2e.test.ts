/**
 * Authenticated send→reply substrate — REAL-SOCKET e2e (#60 Tier-2).
 *
 * Every other agents-mcp / mint test in this repo drives the mount
 * IN-PROCESS (`fetchHandler(new Request(...))`) with no real listener.
 * This one boots the mount on an ephemeral TCP port via `Bun.serve` and
 * walks the FULL authenticated path with the PRODUCTION client helper
 * `mintGatewayJwt` (the same code a real agent uses to connect):
 *
 *   POST /api/agents/mint/challenge  → 32-byte challenge
 *   ed25519-sign the challenge with the agent's private key
 *   POST /api/agents/mint/redeem     → scoped HS256 JWT (sub = signed key)
 *   POST /api/agents/send_message    → deliver to the agent's own inbox
 *   POST /api/agents/get_messages    → read the reply back
 *
 * This is the substrate cognee-claude's upload→reply endpoint wraps, and
 * the concrete proof of the #99 principle: identity is a cryptographic
 * byproduct of signing the challenge with the trusted key, NEVER a
 * caller-supplied field.
 *
 * SCOPE (kept honest): inbox + matrix + PeerKeyDirectory are in-memory
 * doubles, so this is source-level proof of the AUTH / IDENTITY path —
 * not production inbox/Matrix delivery. The four cases together pin the
 * full #99 claim over the wire:
 *   1. happy path  — from_session binds to the JWT sub, not spoofed body
 *   2. no token    — 401 (mint is the only door)
 *   3. wrong scope — a read-only JWT cannot send (action-level enforcement)
 *   4. forged sig  — a challenge signed by the wrong key cannot mint at all
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createPublicKey } from "node:crypto";
import { mintGatewayJwt } from "@agents-js/gateway-inbox-runtime";
import type {
  AgentInboxTool,
  InboxDeliverArgs,
  InboxMessage,
  InboxReadArgs,
  MatrixTool,
  PeerKeyDirectory,
} from "@agents-js/host";
import { bytesToBase64, generateEd25519KeyPair } from "../../../packages/host/src/ed25519.ts";
import { type AgentsMcpEnvConfig, setupAgentsMcpMount } from "../agents-mcp-mount.ts";

const ENTITY = "ajs-authpath-proof";
const SCOPES = ["inbox.deliver", "inbox.read"];
const SIGNING_KEY_TEXT = "authpath-e2e-signing-key-32bytes-or-longer";
const ISSUER = "authpath-e2e-gateway";
const AUDIENCE = "agents-js-mcp";

type RecordingInbox = AgentInboxTool & { delivers: InboxDeliverArgs[] };

/** Stateful in-memory inbox so a self-addressed send→get round-trips. */
function makeStatefulInboxTool(): RecordingInbox {
  const delivers: InboxDeliverArgs[] = [];
  const mailboxes = new Map<string, InboxMessage[]>();
  let seq = 0;
  return {
    delivers,
    async deliver(args: InboxDeliverArgs) {
      delivers.push(args);
      seq += 1;
      const message_id = `msg-${seq}`;
      const created_at = "2026-06-14T00:00:00Z";
      const box = mailboxes.get(args.toSession) ?? [];
      // `from_session` is the SERVER-resolved identity, never a caller arg.
      box.push({
        message_id,
        from_session: args.identity.agentName,
        to_session: args.toSession,
        created_at,
        body: args.body,
      });
      mailboxes.set(args.toSession, box);
      return { message_id, created_at };
    },
    async read(args: InboxReadArgs) {
      return mailboxes.get(args.session) ?? [];
    },
  };
}

/** No-op matrix tool so the mount never spawns the send-matrix subprocess. */
const recordingMatrixTool: MatrixTool = {
  async send() {
    return { event_id: "$noop" };
  },
};

/**
 * Build an in-memory PeerKeyDirectory holding the entity's ed25519 pubkey
 * (raw 32 bytes from the SPKI tail) + its granted capabilities. This is
 * the trust root the redeem flow verifies the signed challenge against.
 */
function makePeerKeyDirectory(publicKeyPem: string): PeerKeyDirectory {
  const spkiDer = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  const rawPubKey = new Uint8Array(spkiDer.subarray(spkiDer.length - 32));
  const pubKeyBase64 = bytesToBase64(rawPubKey);
  return {
    getPubkey: (e) => (e === ENTITY ? pubKeyBase64 : null),
    getCapabilities: (e) => (e === ENTITY ? { scopes: SCOPES } : null),
  };
}

let stopMount: (() => void) | null = null;
let stopServer: (() => void) | null = null;

afterEach(() => {
  stopServer?.();
  stopMount?.();
  stopServer = null;
  stopMount = null;
});

/**
 * Boot the agents-mcp mount on an ephemeral TCP port with the given trusted
 * peer pubkey in the directory. Returns the live base URL + the inbox double.
 * Teardown is handled by the shared `afterEach`.
 */
async function bootMount(trustedPublicKeyPem: string): Promise<{
  baseUrl: string;
  inbox: RecordingInbox;
}> {
  const inbox = makeStatefulInboxTool();
  const config: AgentsMcpEnvConfig = {
    signingKey: new TextEncoder().encode(SIGNING_KEY_TEXT),
    issuer: ISSUER,
    audience: AUDIENCE,
    sendScript: "/unused/send-matrix", // matrixTool override means this is never spawned
    targets: { [ENTITY]: { inbox: { session: ENTITY } } },
    jwtTtlSeconds: 900,
  };
  const wireup = await setupAgentsMcpMount({
    overrides: {
      config,
      agentInboxTool: inbox,
      matrixTool: recordingMatrixTool,
      peerKeyDirectory: makePeerKeyDirectory(trustedPublicKeyPem),
    },
  });
  if (!wireup) throw new Error("mount did not initialize");
  stopMount = wireup.stop;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) =>
      (await wireup.fetchHandler(req)) ??
      new Response(JSON.stringify({ error: "not-found" }), { status: 404 }),
  });
  stopServer = () => server.stop(true);
  return { baseUrl: `http://localhost:${server.port}`, inbox };
}

describe("agents-mcp authenticated send→reply (real socket)", () => {
  test("mint(challenge→sign→redeem) → send_message → get_messages; from_session binds to the ed25519 key, not spoofed body", async () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
    const { baseUrl, inbox } = await bootMount(publicKeyPem);

    // --- Authenticated mint over the wire: challenge → ed25519-sign → redeem ---
    const mint = await mintGatewayJwt({ baseUrl, entity: ENTITY, scopes: SCOPES, privateKeyPem });
    expect(mint.jwt.length).toBeGreaterThan(0);
    expect(mint.sub).toBe(ENTITY); // sub is the signed entity, cryptographically established
    expect(mint.scopes).toEqual(SCOPES);

    // --- send_message with attacker-controlled identity fields (MUST be ignored) ---
    const sendRes = await fetch(`${baseUrl}/api/agents/send_message`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${mint.jwt}` },
      body: JSON.stringify({
        target: ENTITY,
        body: "authenticated round-trip proof",
        as_agent: "spoofed-agent",
        sender: "spoofed-sender",
      }),
    });
    expect(sendRes.status).toBe(200);
    const send = (await sendRes.json()) as { ok: boolean; inbox_message_id: string };
    expect(send.ok).toBe(true);
    expect(inbox.delivers).toHaveLength(1);
    // Identity binding: delivered `from` is the JWT sub, not the spoofed field.
    expect(inbox.delivers[0]?.identity.agentName).toBe(ENTITY);

    // --- get_messages reads the reply back from the same identity ---
    const getRes = await fetch(`${baseUrl}/api/agents/get_messages`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${mint.jwt}` },
      body: "{}",
    });
    expect(getRes.status).toBe(200);
    const get = (await getRes.json()) as { ok: boolean; messages: InboxMessage[] };
    expect(get.ok).toBe(true);
    expect(get.messages).toHaveLength(1);
    expect(get.messages[0]?.body).toBe("authenticated round-trip proof");
    expect(get.messages[0]?.from_session).toBe(ENTITY);
    expect(get.messages[0]?.to_session).toBe(ENTITY);
  });

  test("send_message without a bearer token → 401 over the wire (mint is the only door)", async () => {
    const { publicKeyPem } = generateEd25519KeyPair();
    const { baseUrl } = await bootMount(publicKeyPem);

    const res = await fetch(`${baseUrl}/api/agents/send_message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: ENTITY, body: "no auth" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  test("read-only JWT is rejected on send_message → 403 (scope enforced on the action, not just minted)", async () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
    const { baseUrl, inbox } = await bootMount(publicKeyPem);

    // Mint with ONLY inbox.read (a subset of the peer's capabilities, so redeem succeeds).
    const mint = await mintGatewayJwt({
      baseUrl,
      entity: ENTITY,
      scopes: ["inbox.read"],
      privateKeyPem,
    });
    expect(mint.scopes).toEqual(["inbox.read"]);

    // The action requires inbox.deliver — a valid token without it is forbidden, not unauthenticated.
    const res = await fetch(`${baseUrl}/api/agents/send_message`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${mint.jwt}` },
      body: JSON.stringify({ target: ENTITY, body: "should be denied" }),
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe("scope-not-granted");
    expect(inbox.delivers).toHaveLength(0);
  });

  test("a challenge signed by the WRONG key cannot redeem → no JWT minted (the other half of #99)", async () => {
    // Trust directory holds the trusted key; the client signs with an attacker key.
    const trusted = generateEd25519KeyPair();
    const attacker = generateEd25519KeyPair();
    const { baseUrl } = await bootMount(trusted.publicKeyPem);

    await expect(
      mintGatewayJwt({
        baseUrl,
        entity: ENTITY,
        scopes: SCOPES,
        privateKeyPem: attacker.privateKeyPem,
      }),
    ).rejects.toThrow(/401|signature/i);
  });
});
