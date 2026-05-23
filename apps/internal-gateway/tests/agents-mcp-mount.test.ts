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
import type {
  AgentInboxTool,
  InboxDeliverArgs,
  InboxMessage,
  InboxReadArgs,
  MatrixSendArgs,
  MatrixTool,
} from "@agents-js/host";
import { SignJWT } from "jose";
import {
  type AgentsMcpEnvConfig,
  buildAgentMsgDeliverArgv,
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

function makeRecordingInboxTool(opts?: {
  readReturns?: InboxMessage[];
}): AgentInboxTool & { delivers: InboxDeliverArgs[]; reads: InboxReadArgs[] } {
  const delivers: InboxDeliverArgs[] = [];
  const reads: InboxReadArgs[] = [];
  return {
    delivers,
    reads,
    async deliver(args) {
      delivers.push(args);
      return { message_id: `msg-${delivers.length}`, created_at: "2026-05-22T02:00:00Z" };
    },
    async read(args) {
      reads.push(args);
      return opts?.readReturns ?? [];
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
  // ──────────────────────────────────────────────────────────────────
  // AJS-58 inbox routing + get_messages — HTTP-boundary tests
  // ──────────────────────────────────────────────────────────────────

  /**
   * WHAT: Valid JWT + `inbox.deliver` scope + target with `inbox`
   *       routing → 200, `{ok: true, inbox_message_id, inbox_created_at}`,
   *       and the recording inbox tool sees the JWT's `sub` as the
   *       `from` identity.
   * WHY: Pins the inbox-side mirror of cognee-codex's criterion #1
   *      (vertical path) and #4 (server-resolved identity at the
   *      provider boundary) for the AJS-58 substrate. AJS-65 flat-fields
   *      shape replaces the prior `delivery: "inbox"` discriminator;
   *      consumers narrow on `inbox_message_id` presence instead.
   */
  test("send_message → inbox-only target with inbox.deliver scope → 200 with inbox_message_id (AJS-65)", async () => {
    const inbox = makeRecordingInboxTool();
    const wireup = setupAgentsMcpMount({
      overrides: {
        config: baseConfig({
          targets: { "ajs-claude": { inbox: { session: "ajs-claude" } } },
        }),
        matrixTool: makeRecordingMatrixTool(),
        agentInboxTool: inbox,
      },
    });
    if (wireup === null) throw new Error("unreachable");
    const jwt = await mintTestJwt({ scopes: ["inbox.deliver"], sub: "codex-hostname-null" });
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/send_message", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ target: "ajs-claude", body: "from inbox path" }),
      }),
    );
    expect(res?.status).toBe(200);
    const json = (await res?.json()) as {
      ok: boolean;
      inbox_message_id?: string;
      event_id?: string;
    };
    expect(json.ok).toBe(true);
    expect(json.inbox_message_id).toBe("msg-1");
    // No matrix.room configured for this inbox-only target → no event_id:
    expect(json.event_id).toBeUndefined();
    expect(inbox.delivers).toHaveLength(1);
    expect(inbox.delivers[0]?.toSession).toBe("ajs-claude");
    expect(inbox.delivers[0]?.identity.agentName).toBe("codex-hostname-null");
  });

  /**
   * WHAT: `POST /api/agents/get_messages` with valid JWT + `inbox.read`
   *       scope returns 200 with the inbox messages array. The
   *       recording inbox tool sees `session === identity.agentName`
   *       regardless of any args.
   * WHY: Pins the read-side identity-bound contract end-to-end. v1
   *      MUST refuse cross-agent reads; this asserts the HTTP layer
   *      forwards the constraint.
   */
  test("get_messages → returns messages array; session derives from JWT sub only", async () => {
    const messages: InboxMessage[] = [
      {
        message_id: "m1",
        from_session: "ajs-claude",
        to_session: "codex-hostname-null",
        created_at: "2026-05-22T01:30:00Z",
        body: "hello",
      },
    ];
    const inbox = makeRecordingInboxTool({ readReturns: messages });
    const wireup = setupAgentsMcpMount({
      overrides: {
        config: baseConfig(),
        matrixTool: makeRecordingMatrixTool(),
        agentInboxTool: inbox,
      },
    });
    if (wireup === null) throw new Error("unreachable");
    const jwt = await mintTestJwt({ scopes: ["inbox.read"], sub: "codex-hostname-null" });
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/get_messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({}),
      }),
    );
    expect(res?.status).toBe(200);
    const json = (await res?.json()) as { ok: boolean; messages: InboxMessage[] };
    expect(json.ok).toBe(true);
    expect(json.messages).toHaveLength(1);
    expect(json.messages[0]?.message_id).toBe("m1");
    expect(inbox.reads).toHaveLength(1);
    expect(inbox.reads[0]?.session).toBe("codex-hostname-null");
  });

  /**
   * WHAT: `get_messages` with `target` != identity.agentName → 403
   *       `forbidden-target`. Inbox is NOT called.
   * WHY: HTTP mapping of the v1 self-only-read invariant. 403 (not 401)
   *      because auth succeeded; the caller just isn't allowed to read
   *      another agent's inbox without the future `inbox.read_all`
   *      scope.
   */
  test("get_messages with target != identity → 403 forbidden-target", async () => {
    const inbox = makeRecordingInboxTool();
    const wireup = setupAgentsMcpMount({
      overrides: {
        config: baseConfig(),
        matrixTool: makeRecordingMatrixTool(),
        agentInboxTool: inbox,
      },
    });
    if (wireup === null) throw new Error("unreachable");
    const jwt = await mintTestJwt({ scopes: ["inbox.read"], sub: "codex-hostname-null" });
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/get_messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ target: "ajs-claude" }),
      }),
    );
    expect(res?.status).toBe(403);
    const json = (await res?.json()) as { error: string };
    expect(json.error).toBe("forbidden-target");
    expect(inbox.reads).toHaveLength(0);
  });

  /**
   * WHAT: `get_messages` without `inbox.read` scope → 403
   *       `scope-not-granted`. Inbox is NOT called.
   * WHY: ACL mapping at the HTTP boundary. Mirrors the equivalent
   *      send_message scope check in PR #48.
   */
  test("get_messages without inbox.read scope → 403 scope-not-granted", async () => {
    const inbox = makeRecordingInboxTool();
    const wireup = setupAgentsMcpMount({
      overrides: {
        config: baseConfig(),
        matrixTool: makeRecordingMatrixTool(),
        agentInboxTool: inbox,
      },
    });
    if (wireup === null) throw new Error("unreachable");
    const jwt = await mintTestJwt({ scopes: ["matrix.send_message"], sub: "codex-hostname-null" });
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/get_messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({}),
      }),
    );
    expect(res?.status).toBe(403);
    const json = (await res?.json()) as { error: string };
    expect(json.error).toBe("scope-not-granted");
    expect(inbox.reads).toHaveLength(0);
  });

  /**
   * WHAT: `get_messages` accepts an EMPTY POST body (no JSON) as
   *       "use defaults" — equivalent to `{}`. Returns 200.
   * WHY: GET-shaped intent over POST. A REST client that POSTs with
   *      no body should NOT 400; the args are all optional in v1.
   */
  test("get_messages with empty body → 200 (treats as defaults)", async () => {
    const inbox = makeRecordingInboxTool();
    const wireup = setupAgentsMcpMount({
      overrides: {
        config: baseConfig(),
        matrixTool: makeRecordingMatrixTool(),
        agentInboxTool: inbox,
      },
    });
    if (wireup === null) throw new Error("unreachable");
    const jwt = await mintTestJwt({ scopes: ["inbox.read"], sub: "codex-hostname-null" });
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/get_messages", {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
      }),
    );
    expect(res?.status).toBe(200);
  });

  /**
   * WHAT: `readAgentsMcpEnv` reads `AGENTS_MCP_AGENT_MSG_BIN` into
   *       the parsed `agentMsgBin` field when present, leaves it
   *       undefined when absent.
   * WHY: Env contract pin — deployment automation reads this name,
   *      so a future rename here without a coordinated role change
   *      breaks the deploy silently.
   */
  /**
   * WHAT: `buildAgentMsgDeliverArgv` includes `--correlation <uuid>`
   *       when `correlationId` is UUID-shaped, AND omits the flag
   *       when `correlationId` is a non-UUID string.
   * WHY: Pinned by @cognee-codex source-review on PR #49 (matrix event
   *      `$euNwxjn7bcz9ejs-2N9jC8-4gaGYStQ0YlkR-0CxeMU`). AJS-57
   *      accepts any non-empty string as `cid`; `agent-msg`'s
   *      `MessageMetaSchema` requires UUID. Forwarding a non-UUID
   *      cid into `agent-msg --correlation` exits 1 with "invalid
   *      uuid at meta.correlationId" — valid AJS-57 sessions using
   *      human-readable cids would deliver over Matrix but fail
   *      over inbox.
   *
   * Two-axis pin (UUID + non-UUID) catches both ends of the gate:
   * a regression that always-includes or always-omits would fail
   * the opposite axis.
   */
  test("buildAgentMsgDeliverArgv: UUID cid → --correlation included; non-UUID cid → omitted", () => {
    const baseArgs = {
      identity: {
        agentName: "codex-hostname-null",
        scopes: ["inbox.deliver"] as const,
        correlationId: "x",
        issuer: "test-gateway",
        expiresAt: 0,
      },
      toSession: "ajs-claude",
      body: "hi",
    } satisfies Omit<Parameters<typeof buildAgentMsgDeliverArgv>[0], "correlationId">;

    const withUuid = buildAgentMsgDeliverArgv({
      ...baseArgs,
      correlationId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(withUuid).toContain("--correlation");
    expect(withUuid).toContain("550e8400-e29b-41d4-a716-446655440000");

    const withNonUuid = buildAgentMsgDeliverArgv({
      ...baseArgs,
      correlationId: "smoke-001", // valid AJS-57 cid; NOT UUID
    });
    expect(withNonUuid).not.toContain("--correlation");
    expect(withNonUuid).not.toContain("smoke-001");
  });

  /**
   * WHAT: `buildAgentMsgDeliverArgv` always includes `--from`,
   *       `--no-notify`, the toSession, and the body. The UUID-gate
   *       only affects `--correlation`.
   * WHY: Pins the rest of the argv contract so a regression in the
   *      UUID-gate logic that accidentally drops other args (e.g.
   *      breaks the `--from` thread) would be caught immediately.
   *      Identity is server-resolved; the test asserts `--from
   *      <identity.agentName>` is present regardless of cid shape.
   */
  test("buildAgentMsgDeliverArgv: --from and --no-notify always present; toSession + body in argv", () => {
    const argv = buildAgentMsgDeliverArgv({
      identity: {
        agentName: "codex-hostname-null",
        scopes: ["inbox.deliver"] as const,
        correlationId: "x",
        issuer: "test-gateway",
        expiresAt: 0,
      },
      toSession: "ajs-claude",
      body: "hello",
      // No correlationId — to ensure --from/--no-notify don't accidentally
      // get gated on it.
    });
    expect(argv).toContain("send");
    expect(argv).toContain("ajs-claude");
    expect(argv).toContain("hello");
    expect(argv).toContain("--from");
    expect(argv).toContain("codex-hostname-null");
    expect(argv).toContain("--no-notify");
  });

  test("env parser reads AGENTS_MCP_AGENT_MSG_BIN into config.agentMsgBin", () => {
    const noBin = readAgentsMcpEnv({
      AGENTS_MCP_JWT_SIGNING_KEY: SIGNING_KEY_TEXT,
      AGENTS_MCP_JWT_ISSUER: ISSUER,
      AGENTS_MCP_SEND_SCRIPT: "/x",
    });
    if (noBin === null) throw new Error("unreachable");
    expect(noBin.agentMsgBin).toBeUndefined();

    const withBin = readAgentsMcpEnv({
      AGENTS_MCP_JWT_SIGNING_KEY: SIGNING_KEY_TEXT,
      AGENTS_MCP_JWT_ISSUER: ISSUER,
      AGENTS_MCP_SEND_SCRIPT: "/x",
      AGENTS_MCP_AGENT_MSG_BIN: "/usr/local/bin/agent-msg",
    });
    if (withBin === null) throw new Error("unreachable");
    expect(withBin.agentMsgBin).toBe("/usr/local/bin/agent-msg");
  });

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
