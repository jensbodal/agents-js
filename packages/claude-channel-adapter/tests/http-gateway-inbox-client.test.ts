import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { HttpGatewayInboxClient } from "../src/http-gateway-inbox-client.ts";

const ENTITY = "hostname-null-claude-0";
const BASE = "https://gw.test";

function pem(): string {
  return generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).privateKey;
}

/** Fake gateway: counts mints, serves inbox + send, lets the clock be driven. */
function fakeGateway() {
  const state = { mints: 0, lastAuth: "", lastSendBody: null as Record<string, unknown> | null };
  const fetchImpl = (async (
    url: string,
    init?: { headers?: Record<string, string>; body?: string },
  ) => {
    if (url.endsWith("/mint/challenge")) {
      return new Response(JSON.stringify({ challenge: "CH", expires_at: 1 }), { status: 200 });
    }
    if (url.endsWith("/mint/redeem")) {
      state.mints += 1;
      return new Response(
        JSON.stringify({ jwt: `JWT-${state.mints}`, expires_in: 900, sub: ENTITY, scopes: [] }),
        { status: 200 },
      );
    }
    state.lastAuth = init?.headers?.authorization ?? "";
    if (url.endsWith("/api/agents/get_messages")) {
      return new Response(
        JSON.stringify({ ok: true, messages: [{ message_id: "m1", body: "hi" }] }),
        { status: 200 },
      );
    }
    if (url.endsWith("/api/agents/send_message")) {
      state.lastSendBody = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true, event_id: "$evt" }), { status: 200 });
    }
    return new Response("nf", { status: 404 });
  }) as unknown as typeof fetch;
  return { state, fetchImpl };
}

describe("HttpGatewayInboxClient", () => {
  test("getMessages mints once, sends Bearer, returns entity + rows", async () => {
    const gw = fakeGateway();
    const client = new HttpGatewayInboxClient({
      baseUrl: BASE,
      entity: ENTITY,
      getPrivateKeyPem: async () => pem(),
      fetchImpl: gw.fetchImpl,
      now: () => 1000,
    });
    const r1 = await client.getMessages({ identity: ENTITY });
    expect(r1.ok).toBe(true);
    expect(r1.identity).toBe(ENTITY);
    expect(r1.messages[0]?.message_id).toBe("m1");
    expect(gw.state.lastAuth).toBe("Bearer JWT-1");
    // Second call within TTL reuses the cached JWT — no second mint.
    await client.getMessages({ identity: ENTITY });
    expect(gw.state.mints).toBe(1);
  });

  test("sendMessage posts target/body with Bearer and returns event_id", async () => {
    const gw = fakeGateway();
    const client = new HttpGatewayInboxClient({
      baseUrl: BASE,
      entity: ENTITY,
      getPrivateKeyPem: async () => pem(),
      fetchImpl: gw.fetchImpl,
      now: () => 1000,
    });
    const res = await client.sendMessage({ target: "cognee-claude", body: "yo", identity: ENTITY });
    expect(res.ok).toBe(true);
    expect(res.event_id).toBe("$evt");
    expect(gw.state.lastSendBody).toEqual({ target: "cognee-claude", body: "yo" });
  });

  test("re-mints after the JWT nears expiry", async () => {
    const gw = fakeGateway();
    let t = 1000;
    const client = new HttpGatewayInboxClient({
      baseUrl: BASE,
      entity: ENTITY,
      getPrivateKeyPem: async () => pem(),
      fetchImpl: gw.fetchImpl,
      now: () => t,
      refreshMarginMs: 60_000,
    });
    await client.getMessages({ identity: ENTITY }); // mint #1, expires at 1000 + 900_000
    t += 900_000; // now inside the 60s refresh margin
    await client.getMessages({ identity: ENTITY }); // mint #2
    expect(gw.state.mints).toBe(2);
    expect(gw.state.lastAuth).toBe("Bearer JWT-2");
  });

  test("surfaces a non-200 from the gateway", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/mint/challenge"))
        return new Response(JSON.stringify({ challenge: "CH", expires_at: 1 }), { status: 200 });
      if (url.endsWith("/mint/redeem"))
        return new Response(JSON.stringify({ jwt: "J", expires_in: 900, sub: ENTITY }), {
          status: 200,
        });
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }) as unknown as typeof fetch;
    const client = new HttpGatewayInboxClient({
      baseUrl: BASE,
      entity: ENTITY,
      getPrivateKeyPem: async () => pem(),
      fetchImpl,
      now: () => 1000,
    });
    await expect(client.getMessages({ identity: ENTITY })).rejects.toThrow(/HTTP 401/);
  });
});
