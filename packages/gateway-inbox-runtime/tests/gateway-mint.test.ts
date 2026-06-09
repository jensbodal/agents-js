import { describe, expect, test } from "bun:test";
import { createPublicKey, verify as cryptoVerify, generateKeyPairSync } from "node:crypto";
import { buildSignedBytes, canonicalSignedObject, mintGatewayJwt } from "../src/gateway-mint.ts";

const ENTITY = "hostname-null-claude-0";
const SCOPES = ["inbox.read", "inbox.deliver", "matrix.send_message"];

function makeKeypair(): { publicKey: string; privateKey: string } {
  return generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

describe("canonicalSignedObject", () => {
  test("keys in JCS order, compact, no sig/cid", () => {
    expect(canonicalSignedObject("CH", ENTITY, SCOPES)).toBe(
      `{"challenge":"CH","entity":"${ENTITY}","requested_scopes":["inbox.read","inbox.deliver","matrix.send_message"]}`,
    );
  });
});

describe("buildSignedBytes", () => {
  test("domain separator || 0x0A || canonical JSON", () => {
    const bytes = buildSignedBytes("CH", ENTITY, SCOPES);
    const s = bytes.toString("utf8");
    expect(s.startsWith("agents-js:challenge-mint:v1\n")).toBe(true);
    expect(s.endsWith(canonicalSignedObject("CH", ENTITY, SCOPES))).toBe(true);
    expect(bytes[Buffer.byteLength("agents-js:challenge-mint:v1")]).toBe(0x0a);
  });
});

describe("mintGatewayJwt", () => {
  test("signature verifies against the entity public key; returns the jwt", async () => {
    const { publicKey, privateKey } = makeKeypair();
    const CHALLENGE = Buffer.from("deadbeefdeadbeefdeadbeefdeadbeef").toString("base64");
    let redeem: Record<string, unknown> | null = null;

    const fakeFetch = (async (url: string, init?: { body?: string }) => {
      if (url.endsWith("/mint/challenge")) {
        return new Response(
          JSON.stringify({ challenge: CHALLENGE, expires_at: 9_999_999_999_999 }),
          {
            status: 200,
          },
        );
      }
      if (url.endsWith("/mint/redeem")) {
        redeem = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
        // Independent verification — exactly what the gateway does.
        const verified = cryptoVerify(
          null,
          buildSignedBytes(
            redeem.challenge as string,
            redeem.entity as string,
            redeem.requested_scopes as string[],
          ),
          createPublicKey(publicKey),
          Buffer.from(redeem.sig as string, "base64"),
        );
        if (!verified) return new Response(JSON.stringify({ error: "bad-sig" }), { status: 401 });
        return new Response(
          JSON.stringify({
            jwt: "JWT123",
            expires_in: 900,
            sub: redeem.entity,
            scopes: redeem.requested_scopes,
            cid: "cid-1",
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const res = await mintGatewayJwt({
      baseUrl: "https://gw.test",
      entity: ENTITY,
      scopes: SCOPES,
      privateKeyPem: privateKey,
      fetchImpl: fakeFetch,
    });

    expect(res.jwt).toBe("JWT123");
    expect(res.sub).toBe(ENTITY);
    expect(res.expires_in).toBe(900);
    const body = redeem as unknown as Record<string, unknown>;
    expect(body.challenge).toBe(CHALLENGE);
    expect(body.entity).toBe(ENTITY);
    expect(body.requested_scopes).toEqual(SCOPES);
    expect(typeof body.sig).toBe("string");
    expect("cid" in body).toBe(false); // none passed → gateway generates
  });

  test("includes cid when supplied", async () => {
    const { privateKey } = makeKeypair();
    let redeem: Record<string, unknown> = {};
    const fakeFetch = (async (url: string, init?: { body?: string }) => {
      if (url.endsWith("/mint/challenge"))
        return new Response(JSON.stringify({ challenge: "CH", expires_at: 1 }), { status: 200 });
      redeem = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      return new Response(
        JSON.stringify({ jwt: "J", expires_in: 900, sub: ENTITY, scopes: SCOPES }),
        {
          status: 200,
        },
      );
    }) as unknown as typeof fetch;
    await mintGatewayJwt({
      baseUrl: "https://gw.test",
      entity: ENTITY,
      scopes: SCOPES,
      privateKeyPem: privateKey,
      cid: "11111111-1111-1111-1111-111111111111",
      fetchImpl: fakeFetch,
    });
    expect(redeem.cid).toBe("11111111-1111-1111-1111-111111111111");
  });

  test("throws on missing challenge", async () => {
    const { privateKey } = makeKeypair();
    const fakeFetch = (async (url: string) => {
      if (url.endsWith("/mint/challenge")) return new Response(JSON.stringify({}), { status: 200 });
      return new Response("x", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      mintGatewayJwt({
        baseUrl: "https://gw.test",
        entity: ENTITY,
        scopes: SCOPES,
        privateKeyPem: privateKey,
        fetchImpl: fakeFetch,
      }),
    ).rejects.toThrow(/missing challenge/);
  });

  test("rejects a mint result for the wrong subject before caching", async () => {
    const { privateKey } = makeKeypair();
    const fakeFetch = (async (url: string) => {
      if (url.endsWith("/mint/challenge"))
        return new Response(JSON.stringify({ challenge: "CH", expires_at: 1 }), { status: 200 });
      return new Response(
        JSON.stringify({
          jwt: "J",
          expires_in: 900,
          sub: "someone-else",
          scopes: SCOPES,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await expect(
      mintGatewayJwt({
        baseUrl: "https://gw.test",
        entity: ENTITY,
        scopes: SCOPES,
        privateKeyPem: privateKey,
        fetchImpl: fakeFetch,
      }),
    ).rejects.toThrow(/sub mismatch/);
  });

  test("rejects a mint result missing a requested scope", async () => {
    const { privateKey } = makeKeypair();
    const fakeFetch = (async (url: string) => {
      if (url.endsWith("/mint/challenge"))
        return new Response(JSON.stringify({ challenge: "CH", expires_at: 1 }), { status: 200 });
      return new Response(
        JSON.stringify({
          jwt: "J",
          expires_in: 900,
          sub: ENTITY,
          scopes: ["inbox.read"],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await expect(
      mintGatewayJwt({
        baseUrl: "https://gw.test",
        entity: ENTITY,
        scopes: SCOPES,
        privateKeyPem: privateKey,
        fetchImpl: fakeFetch,
      }),
    ).rejects.toThrow(/missing requested scopes/);
  });

  test("surfaces a redeem HTTP error (bad sig / rate limit)", async () => {
    const { privateKey } = makeKeypair();
    const fakeFetch = (async (url: string) => {
      if (url.endsWith("/mint/challenge"))
        return new Response(JSON.stringify({ challenge: "CH", expires_at: 1 }), { status: 200 });
      return new Response(JSON.stringify({ error: "rate-limited", retry_after_ms: 500 }), {
        status: 429,
      });
    }) as unknown as typeof fetch;
    await expect(
      mintGatewayJwt({
        baseUrl: "https://gw.test",
        entity: ENTITY,
        scopes: SCOPES,
        privateKeyPem: privateKey,
        fetchImpl: fakeFetch,
      }),
    ).rejects.toThrow(/HTTP 429/);
  });
});
