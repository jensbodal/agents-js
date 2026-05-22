/**
 * Wire-up tests for the AJS-56/57 internal-gateway integration.
 *
 * Behavior pinned here mirrors the per-module tests at the
 * `@agents-js/host` boundary (jwt-verifier, scope-acl,
 * agents-tool-surface) but composes them through the actual
 * HTTP-handler surface the gateway mounts. The point is the
 * INTEGRATION CONTRACT — that the handler, when given a valid signed
 * JWT and routable target, sends through to Matrix; and when given
 * any failure-mode input, returns the structured error contract
 * callers depend on.
 *
 * Tests deliberately bypass the subprocess sender by injecting a
 * recording {@link MatrixTool} via `overrides.matrixTool` — the
 * subprocess path is exercised via the integration smoke in
 * `dot-proxmox`'s ansible role, not here.
 */

import { describe, expect, test } from "bun:test";
import type { MatrixSendArgs, MatrixTool } from "@agents-js/host";
import { SignJWT } from "jose";
import {
  type AgentsMcpEnvConfig,
  readAgentsMcpEnv,
  setupAgentsMcpMount,
} from "../agents-mcp-mount.ts";

const SIGNING_KEY_TEXT = "test-signing-key-32bytes-or-more-abcdef";
const ISSUER = "test-gateway";
const AUDIENCE = "agents-js-mcp";
const ADMIN_TOKEN = "test-admin-secret";

function baseConfig(overrides: Partial<AgentsMcpEnvConfig> = {}): AgentsMcpEnvConfig {
  return {
    signingKey: new TextEncoder().encode(SIGNING_KEY_TEXT),
    issuer: ISSUER,
    audience: AUDIENCE,
    sendScript: "/unused-in-tests",
    targets: {
      "ajs-claude": { matrix: { room: "!ajs:matrix.example" } },
      "cognee-codex": { matrix: { room: "!cog:matrix.example" } },
    },
    jwtTtlSeconds: 900,
    ...overrides,
  };
}

function makeRecordingMatrixTool(): MatrixTool & { calls: MatrixSendArgs[] } {
  const calls: MatrixSendArgs[] = [];
  return {
    calls,
    async send(args) {
      calls.push(args);
      return { event_id: `$evt-${calls.length}` };
    },
  };
}

async function mintTestJwt(
  overrides: { sub?: string; scopes?: string[]; cid?: string; aud?: string; iss?: string } = {},
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    scopes: overrides.scopes ?? ["matrix.send_message", "matrix.read"],
    cid: overrides.cid ?? "cid-test-001",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(overrides.sub ?? "codex-hostname-null")
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? AUDIENCE)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + 900)
    .sign(new TextEncoder().encode(SIGNING_KEY_TEXT));
}

describe("apps/internal-gateway/tests/agents-mcp-mount.test.ts", () => {
  /**
   * WHAT: `readAgentsMcpEnv` returns `null` when `AGENTS_MCP_JWT_SIGNING_KEY`
   *       is absent.
   * WHY: Opt-in default. The mount must not stand up an authenticated
   *      endpoint without explicit operator configuration. A "ships
   *      enabled by default" footgun would let dev gateways accept
   *      tool calls without the operator realizing.
   */
  test("env without signing key → readAgentsMcpEnv returns null", () => {
    expect(readAgentsMcpEnv({})).toBeNull();
  });

  /**
   * WHAT: `readAgentsMcpEnv` throws when the signing key is shorter
   *       than 32 bytes (HS256 minimum).
   * WHY: HS256 with a short key is cryptographically weak — RFC 7518
   *      §3.2 requires a key at least the size of the hash output.
   *      Failing fast at startup is friendlier than silently
   *      degraded auth.
   */
  test("env with short signing key → throws at parse time", () => {
    expect(() =>
      readAgentsMcpEnv({ AGENTS_MCP_JWT_SIGNING_KEY: "too-short", AGENTS_MCP_JWT_ISSUER: "x" }),
    ).toThrow(/at least 32 bytes/);
  });

  /**
   * WHAT: `readAgentsMcpEnv` throws when the signing key is set but
   *       `AGENTS_MCP_JWT_ISSUER` or `AGENTS_MCP_SEND_SCRIPT` is missing.
   * WHY: Half-configured mounts would publish auth without identity
   *      provenance (no issuer) or accept tool calls with no Matrix
   *      backend (no script). The fail-fast forces the operator to
   *      complete the contract before the gateway boots.
   */
  test("env with signing key but missing required vars → throws", () => {
    expect(() => readAgentsMcpEnv({ AGENTS_MCP_JWT_SIGNING_KEY: SIGNING_KEY_TEXT })).toThrow(
      /AGENTS_MCP_JWT_ISSUER/,
    );
    expect(() =>
      readAgentsMcpEnv({
        AGENTS_MCP_JWT_SIGNING_KEY: SIGNING_KEY_TEXT,
        AGENTS_MCP_JWT_ISSUER: "gw",
      }),
    ).toThrow(/AGENTS_MCP_SEND_SCRIPT/);
  });

  /**
   * WHAT: `setupAgentsMcpMount` returns `null` when env disables the mount.
   * WHY: Pins the contract that the gateway boots unchanged in dev when
   *      `AGENTS_MCP_JWT_SIGNING_KEY` is absent.
   */
  test("setupAgentsMcpMount returns null when env disables the mount", () => {
    expect(setupAgentsMcpMount({ overrides: { env: {} } })).toBeNull();
  });

  /**
   * WHAT: A valid JWT + valid args + reachable target → 200 with
   *       `{ ok: true, event_id }`; the recording MatrixTool sees
   *       `identity.agentName` set to the JWT's `sub`, not to anything
   *       in the request body.
   * WHY: Maps to cognee-codex review criteria #1, #2, #4 — the full
   *      vertical works AND identity is server-resolved. The negative-
   *      assertion ("body's `as_agent` did not become identity")
   *      runs as part of the success path, not a separate failure
   *      test, so a regression cannot pass by simply rejecting all
   *      impersonation attempts (it must accept the call AND ignore
   *      the override).
   */
  test("end-to-end happy path: JWT → verify → dispatch → recording Matrix; ignores caller `as_agent`", async () => {
    const matrix = makeRecordingMatrixTool();
    const wireup = setupAgentsMcpMount({
      overrides: { config: baseConfig(), matrixTool: matrix },
    });
    if (wireup === null) throw new Error("unreachable");

    const jwt = await mintTestJwt({ sub: "codex-hostname-null" });
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/send_message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          target: "ajs-claude",
          body: "hello",
          as_agent: "spoofed-agent", // attacker-controlled
          sender: "spoofed-sender", // attacker-controlled
        }),
      }),
    );
    expect(res?.status).toBe(200);
    const json = (await res?.json()) as { ok: boolean; event_id: string };
    expect(json.ok).toBe(true);
    expect(json.event_id).toMatch(/^\$evt-/);
    expect(matrix.calls).toHaveLength(1);
    expect(matrix.calls[0]?.identity.agentName).toBe("codex-hostname-null");
    expect(matrix.calls[0]?.room).toBe("!ajs:matrix.example");
  });

  /**
   * WHAT: Missing `Authorization` header → 401 with
   *       `WWW-Authenticate: Bearer realm="agents-js-mcp"` and
   *       `error: "missing-bearer"`. MatrixTool is NOT called.
   * WHY: RFC 6750 §3 conformance — 401 responses MUST include
   *      `WWW-Authenticate`. Some clients drive their token-refresh
   *      flow off that header; omitting it would silently break
   *      compliant clients.
   */
  test("no Authorization header → 401 missing-bearer + WWW-Authenticate; provider not called", async () => {
    const matrix = makeRecordingMatrixTool();
    const wireup = setupAgentsMcpMount({
      overrides: { config: baseConfig(), matrixTool: matrix },
    });
    if (wireup === null) throw new Error("unreachable");
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/send_message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "ajs-claude", body: "hi" }),
      }),
    );
    expect(res?.status).toBe(401);
    expect(res?.headers.get("WWW-Authenticate")).toContain("Bearer");
    const json = (await res?.json()) as { error: string };
    expect(json.error).toBe("missing-bearer");
    expect(matrix.calls).toHaveLength(0);
  });

  /**
   * WHAT: Wrong-signature JWT → 401 with `error: "signature-invalid"`.
   * WHY: Smoke-tests the verifier wiring at the HTTP boundary. Without
   *      this, a regression that accidentally skipped signature
   *      verification would still pass the missing-bearer test.
   */
  test("forged JWT (wrong signing key) → 401 signature-invalid", async () => {
    const wireup = setupAgentsMcpMount({
      overrides: { config: baseConfig(), matrixTool: makeRecordingMatrixTool() },
    });
    if (wireup === null) throw new Error("unreachable");
    const forged = await new SignJWT({ scopes: ["matrix.send_message"], cid: "cid-x" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("codex-hostname-null")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(new TextEncoder().encode("DIFFERENT-key-32bytes-12345678901234"));
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/send_message", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${forged}` },
        body: JSON.stringify({ target: "ajs-claude", body: "hi" }),
      }),
    );
    expect(res?.status).toBe(401);
    const json = (await res?.json()) as { error: string };
    expect(json.error).toBe("signature-invalid");
  });

  /**
   * WHAT: Valid JWT without the `matrix.send_message` scope → 403
   *       with `error: "scope-not-granted"`. MatrixTool not called.
   * WHY: Pins the scope ACL → HTTP-status mapping. Returning 401 here
   *      (auth failed) would confuse callers — the token IS valid;
   *      the call is just unauthorized.
   */
  test("JWT without matrix.send_message scope → 403 scope-not-granted", async () => {
    const matrix = makeRecordingMatrixTool();
    const wireup = setupAgentsMcpMount({
      overrides: { config: baseConfig(), matrixTool: matrix },
    });
    if (wireup === null) throw new Error("unreachable");
    const jwt = await mintTestJwt({ scopes: ["matrix.read"] });
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/send_message", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ target: "ajs-claude", body: "hi" }),
      }),
    );
    expect(res?.status).toBe(403);
    const json = (await res?.json()) as { error: string };
    expect(json.error).toBe("scope-not-granted");
    expect(matrix.calls).toHaveLength(0);
  });

  /**
   * WHAT: Valid JWT + scope, but unknown target → 404 with
   *       `error: "unknown-target"`, `target` echoed, `correlation_id`
   *       echoed from JWT's `cid`. MatrixTool not called.
   * WHY: Maps to cognee-codex criterion #3 + audit-chain propagation.
   *      The `correlation_id` echo is what makes the failure
   *      diagnosable across the bus → Matrix → operator log chain.
   */
  test("unknown target → 404 unknown-target with target + correlation_id echoed", async () => {
    const matrix = makeRecordingMatrixTool();
    const wireup = setupAgentsMcpMount({
      overrides: { config: baseConfig(), matrixTool: matrix },
    });
    if (wireup === null) throw new Error("unreachable");
    const jwt = await mintTestJwt({ cid: "cid-traceable-9" });
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/send_message", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ target: "ghost-agent", body: "hi" }),
      }),
    );
    expect(res?.status).toBe(404);
    const json = (await res?.json()) as { error: string; target: string; correlation_id: string };
    expect(json.error).toBe("unknown-target");
    expect(json.target).toBe("ghost-agent");
    expect(json.correlation_id).toBe("cid-traceable-9");
    expect(matrix.calls).toHaveLength(0);
  });

  /**
   * WHAT: GET requests to the send_message endpoint → 405 with
   *       `Allow: POST` response header.
   * WHY: Tool dispatch is state-mutating; only POST is meaningful.
   *      Pinning the 405 + Allow header keeps the contract explicit;
   *      some clients pre-flight with GET to discover allowed methods.
   */
  test("GET /api/agents/send_message → 405 with Allow: POST", async () => {
    const wireup = setupAgentsMcpMount({
      overrides: { config: baseConfig(), matrixTool: makeRecordingMatrixTool() },
    });
    if (wireup === null) throw new Error("unreachable");
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/send_message", { method: "GET" }),
    );
    expect(res?.status).toBe(405);
    expect(res?.headers.get("Allow")).toBe("POST");
  });

  /**
   * WHAT: Non-`/api/agents/*` paths pass through (`fetchHandler`
   *       returns `null`), so AG-UI / Plane / Gitea handlers are
   *       unaffected.
   * WHY: The mount lives in `composeAdditionalFetch`'s chain;
   *      returning a non-null Response for unrelated paths would
   *      shadow AG-UI's `/agent` route. Pin the null-passthrough
   *      contract here at the integration level (parallel pin to
   *      the unit test on the same property at the dispatcher level).
   */
  test("non-/api/agents/ paths pass through (return null)", async () => {
    const wireup = setupAgentsMcpMount({
      overrides: { config: baseConfig(), matrixTool: makeRecordingMatrixTool() },
    });
    if (wireup === null) throw new Error("unreachable");
    const res = await wireup.fetchHandler(new Request("http://gw.local/agent", { method: "POST" }));
    expect(res).toBeNull();
  });

  /**
   * WHAT: `/api/agents/admin/mint` with the correct admin token →
   *       returns a JWT that the same handler can verify on the next
   *       `send_message` call.
   * WHY: Round-trip dogfood. Without this, the admin mint endpoint
   *      could ship "minting JWTs the gateway can't accept" — a
   *      catastrophic but easy-to-miss regression. The pair-test
   *      pins both halves of the mint+verify roundtrip.
   */
  test("admin mint → returns JWT that the same gateway verifies", async () => {
    const matrix = makeRecordingMatrixTool();
    const wireup = setupAgentsMcpMount({
      overrides: { config: baseConfig({ adminToken: ADMIN_TOKEN }), matrixTool: matrix },
    });
    if (wireup === null) throw new Error("unreachable");
    const mintRes = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/admin/mint", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Admin ${ADMIN_TOKEN}` },
        body: JSON.stringify({
          sub: "ajs-claude",
          scopes: ["matrix.send_message"],
          cid: "cid-roundtrip-1",
        }),
      }),
    );
    expect(mintRes?.status).toBe(200);
    const mint = (await mintRes?.json()) as { jwt: string; sub: string };
    expect(mint.sub).toBe("ajs-claude");

    const sendRes = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/send_message", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mint.jwt}` },
        body: JSON.stringify({ target: "cognee-codex", body: "round-trip works" }),
      }),
    );
    expect(sendRes?.status).toBe(200);
    expect(matrix.calls).toHaveLength(1);
    expect(matrix.calls[0]?.identity.agentName).toBe("ajs-claude");
  });

  /**
   * WHAT: `/api/agents/admin/mint` is 404 when `AGENTS_MCP_ADMIN_TOKEN`
   *       is NOT set in env (default disabled).
   * WHY: The mint endpoint is a deliberate stub for AJS-55 challenge
   *      verification; leaving it implicitly enabled in production
   *      would be a serious security regression. Default-disabled
   *      is pinned here — flipping that default requires changing
   *      this test deliberately.
   */
  test("admin mint disabled by default (no AGENTS_MCP_ADMIN_TOKEN) → 404", async () => {
    const wireup = setupAgentsMcpMount({
      overrides: { config: baseConfig(), matrixTool: makeRecordingMatrixTool() },
    });
    if (wireup === null) throw new Error("unreachable");
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/admin/mint", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Admin anything" },
        body: JSON.stringify({ sub: "x", cid: "y" }),
      }),
    );
    expect(res?.status).toBe(404);
  });

  /**
   * WHAT: `/api/agents/admin/mint` with the WRONG admin token → 401.
   * WHY: The endpoint is enabled in this test (token set in config),
   *      but the request carries the wrong value. Must reject. This
   *      test exists separately from the "disabled by default" test
   *      because the failure modes are distinct: disabled → 404
   *      (no such endpoint), enabled-but-bad-auth → 401 (auth required).
   */
  test("admin mint enabled but wrong token → 401", async () => {
    const wireup = setupAgentsMcpMount({
      overrides: {
        config: baseConfig({ adminToken: ADMIN_TOKEN }),
        matrixTool: makeRecordingMatrixTool(),
      },
    });
    if (wireup === null) throw new Error("unreachable");
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/admin/mint", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Admin wrong-secret" },
        body: JSON.stringify({ sub: "x", cid: "y" }),
      }),
    );
    expect(res?.status).toBe(401);
  });
});
