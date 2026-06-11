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
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentInboxTool,
  InboxDeliverArgs,
  InboxMessage,
  InboxReadArgs,
} from "@agents-js/host";
import { makeRecordingMatrixTool, mintTestJwt as mintSharedJwt } from "@agents-js/host/testing";
import { SignJWT } from "jose";
import {
  type AgentsMcpEnvConfig,
  buildAgentMsgDeliverArgv,
  buildDispatchTargetDirectory,
  buildSendMatrixCliArgs,
  createSubprocessAgentInboxTool,
  parseMatrixOriginEnvelope,
  readAgentsMcpEnv,
  setupAgentsMcpMount,
} from "../agents-mcp-mount.ts";
import { createTestAgentsMcpConfig } from "../testing.ts";

const SIGNING_KEY_TEXT = "test-signing-key-32bytes-or-more-abcdef";
const ISSUER = "test-gateway";
const AUDIENCE = "agents-js-mcp";
const ADMIN_TOKEN = "test-admin-secret";

function baseConfig(overrides: Partial<AgentsMcpEnvConfig> = {}): AgentsMcpEnvConfig {
  return createTestAgentsMcpConfig({
    signingKey: new TextEncoder().encode(SIGNING_KEY_TEXT),
    issuer: ISSUER,
    audience: AUDIENCE,
    targets: {
      "ajs-claude": { matrix: { room: "!ajs:matrix.example" }, inbox: { session: "ajs-claude" } },
      "cognee-codex": {
        matrix: { room: "!cog:matrix.example" },
        inbox: { session: "cognee-codex" },
      },
    },
    ...overrides,
  });
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

/** Mint an HS256 JWT pinned to this suite's signing key + default sub/issuer/audience. */
async function mintTestJwt(
  overrides: { sub?: string; scopes?: string[]; cid?: string; aud?: string; iss?: string } = {},
): Promise<string> {
  return mintSharedJwt({
    sub: "codex-hostname-null",
    iss: ISSUER,
    aud: AUDIENCE,
    key: new TextEncoder().encode(SIGNING_KEY_TEXT),
    ...overrides,
  });
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
  test("setupAgentsMcpMount returns null when env disables the mount", async () => {
    expect(await setupAgentsMcpMount({ overrides: { env: {} } })).toBeNull();
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
    const inbox = makeRecordingInboxTool();
    const wireup = await setupAgentsMcpMount({
      overrides: { config: baseConfig(), matrixTool: matrix, agentInboxTool: inbox },
    });
    if (wireup === null) throw new Error("unreachable");

    const jwt = await mintTestJwt({
      sub: "codex-hostname-null",
      scopes: ["matrix.send_message", "inbox.deliver"],
    });
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
    const json = (await res?.json()) as {
      ok: boolean;
      inbox_message_id: string;
      event_id: string;
    };
    expect(json.ok).toBe(true);
    expect(json.inbox_message_id).toMatch(/^msg-/);
    expect(json.event_id).toMatch(/^\$evt-/);
    expect(matrix.calls).toHaveLength(1);
    expect(matrix.calls[0]?.identity.agentName).toBe("codex-hostname-null");
    expect(matrix.calls[0]?.target).toBe("ajs-claude");
    expect(matrix.calls[0]?.room).toBe("!ajs:matrix.example");
  });

  /**
   * WHAT: Matrix notifications pass the resolved target as a structured
   *       `send-matrix.py --to <target>` recipient, not only as body text.
   * WHY: The Matrix bridge enforces recipient intent for agent senders;
   *      the HTTP/MCP `target` field must carry through to Matrix
   *      delivery so callers do not have to duplicate `@target` in the
   *      message body.
   */
  test("send-matrix argv includes structured recipient target", () => {
    const argv = buildSendMatrixCliArgs({
      identity: {
        agentName: "cognee-codex",
        scopes: ["matrix.send_message"],
        correlationId: "cid-test",
        issuer: ISSUER,
        expiresAt: 1_779_000_000,
      },
      target: "ajs-claude",
      room: "!ajs:matrix.example",
      body: "hello without a textual mention",
      replyToEventId: "$reply",
    });

    expect(argv).toEqual([
      "--as",
      "cognee-codex",
      "--stdin",
      "--room",
      "!ajs:matrix.example",
      "--to",
      "ajs-claude",
      "--reply-to",
      "$reply",
    ]);
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
    const wireup = await setupAgentsMcpMount({
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
    const wireup = await setupAgentsMcpMount({
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
   * WHAT: Valid JWT without the `inbox.deliver` scope → 403 with
   *       `error: "scope-not-granted"`. MatrixTool not called. Inbox is
   *       the mandatory durable substrate, so its scope is always required.
   * WHY: Pins the scope ACL → HTTP-status mapping. Returning 401 here
   *      (auth failed) would confuse callers — the token IS valid;
   *      the call is just unauthorized.
   */
  test("JWT without inbox.deliver scope → 403 scope-not-granted", async () => {
    const matrix = makeRecordingMatrixTool();
    const wireup = await setupAgentsMcpMount({
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
    const wireup = await setupAgentsMcpMount({
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
    const wireup = await setupAgentsMcpMount({
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
    const wireup = await setupAgentsMcpMount({
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
    const inbox = makeRecordingInboxTool();
    const wireup = await setupAgentsMcpMount({
      overrides: {
        config: baseConfig({ adminToken: ADMIN_TOKEN }),
        matrixTool: matrix,
        agentInboxTool: inbox,
      },
    });
    if (wireup === null) throw new Error("unreachable");
    const mintRes = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/admin/mint", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Admin ${ADMIN_TOKEN}` },
        body: JSON.stringify({
          sub: "ajs-claude",
          scopes: ["matrix.send_message", "inbox.deliver"],
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
    expect(inbox.delivers).toHaveLength(1);
    expect(inbox.delivers[0]?.identity.agentName).toBe("ajs-claude");
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
    const wireup = await setupAgentsMcpMount({
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
    const wireup = await setupAgentsMcpMount({
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
    const wireup = await setupAgentsMcpMount({
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
    const wireup = await setupAgentsMcpMount({
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
    const wireup = await setupAgentsMcpMount({
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
    const wireup = await setupAgentsMcpMount({
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
      kind: "agents_message" as const,
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
      kind: "agents_message",
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

  // ============================================================
  //
  // AJS-88 / DOT-502 v0.2 — InboxDeliverArgs contract widening
  // ============================================================

  /**
   * WHAT: When `idempotencyKey`, `matrixOrigin`, and `kind` are all
   *       supplied, `buildAgentMsgDeliverArgv` forwards each as the
   *       agreed CLI flag (`--idempotency-key`, `--matrix-origin-json`,
   *       `--kind`). The matrix-origin envelope is JSON-stringified into
   *       a single arg slot so the structured shape rides one CLI arg.
   * WHY:  Pins the wire-shape for the bridge→gateway→CLI thread that
   *       DOT-502 v0.2 §8 / spec hand-off depends on. A regression that
   *       drops or renames any of these flags silently breaks bridge
   *       fanout. The matrix_origin JSON shape pin guards the snake-case
   *       field-naming agreement with the bridge author lane.
   */
  test("buildAgentMsgDeliverArgv: forwards idempotencyKey + matrixOrigin + kind as CLI flags", () => {
    const argv = buildAgentMsgDeliverArgv({
      identity: {
        agentName: "matrix-bridge-fanout",
        scopes: ["inbox.deliver"] as const,
        correlationId: "x",
        issuer: "test-gateway",
        expiresAt: 0,
      },
      toSession: "hostname-null-codex-app",
      body: "@hostname-null-codex-app please ack",
      idempotencyKey: "$evt-abc:hostname-null-codex-app",
      matrixOrigin: {
        event_id: "$evt-abc:matrix.example",
        room_id: "!room:matrix.example",
        sender: "@user:matrix.example",
        origin_server_ts: 1748263200000,
        reply_to_event_id: "$evt-prev:matrix.example",
      },
      kind: "matrix_room_mention",
    });
    // idempotency-key flag + value
    expect(argv).toContain("--idempotency-key");
    expect(argv).toContain("$evt-abc:hostname-null-codex-app");
    // kind flag + value
    expect(argv).toContain("--kind");
    expect(argv).toContain("matrix_room_mention");
    // matrix-origin-json flag carries a parseable JSON string with all
    // five envelope fields.
    expect(argv).toContain("--matrix-origin-json");
    const idx = argv.indexOf("--matrix-origin-json");
    expect(idx).toBeGreaterThanOrEqual(0);
    const jsonArg = argv[idx + 1];
    expect(typeof jsonArg).toBe("string");
    const parsed = JSON.parse(jsonArg as string) as Record<string, unknown>;
    expect(parsed.event_id).toBe("$evt-abc:matrix.example");
    expect(parsed.room_id).toBe("!room:matrix.example");
    expect(parsed.sender).toBe("@user:matrix.example");
    expect(parsed.origin_server_ts).toBe(1748263200000);
    expect(parsed.reply_to_event_id).toBe("$evt-prev:matrix.example");
  });

  /**
   * WHAT: Native `agents.send_message` callers carry `--kind
   *       agents_message` (the mandatory origin discriminator) but omit
   *       the bridge-only `--idempotency-key` / `--matrix-origin-json`
   *       flags. No stray `undefined` / `null` argv slots.
   * WHY:  `kind` is a required field on the inbox-deliver contract; the
   *       dispatcher always passes `"agents_message"` for native sends.
   *       The bridge-only flags stay absent for non-bridge senders.
   */
  test("buildAgentMsgDeliverArgv: native send carries --kind, omits bridge-only flags", () => {
    const argv = buildAgentMsgDeliverArgv({
      identity: {
        agentName: "codex-hostname-null",
        scopes: ["inbox.deliver"] as const,
        correlationId: "x",
        issuer: "test-gateway",
        expiresAt: 0,
      },
      toSession: "ajs-claude",
      body: "native send",
      kind: "agents_message",
    });
    expect(argv).toContain("--kind");
    expect(argv).toContain("agents_message");
    expect(argv).not.toContain("--idempotency-key");
    expect(argv).not.toContain("--matrix-origin-json");
    // Sanity check: no stray "undefined" / "null" string slots either.
    expect(argv).not.toContain("undefined");
    expect(argv).not.toContain("null");
  });

  /**
   * WHAT: When the CLI returns `alreadyDelivered: true` in the JSON
   *       response, `deliver()` surfaces it as `already_delivered: true`
   *       on the typed result. When the CLI omits the field (pre-v0.2),
   *       the result's `already_delivered` stays undefined.
   * WHY:  Spec §4 idempotency wire-shape: bridge fanout treats
   *       `already_delivered: true` as success-without-retry. The
   *       type-level surface ships in Stage 1 ahead of the CLI side
   *       (Stage 2) so consumers can pattern against the field from
   *       day one.
   */
  test("createSubprocessAgentInboxTool: alreadyDelivered:true CLI output → result.already_delivered === true", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ajs-88-cli-already-"));
    const binPath = join(tmp, "agent-msg-stub");
    const script = [
      "#!/bin/sh",
      'echo "{\\"messageId\\":\\"msg-existing-1\\",\\"createdAt\\":\\"2026-05-22T02:00:00Z\\",\\"alreadyDelivered\\":true}"',
      "exit 0",
    ].join("\n");
    writeFileSync(binPath, `${script}\n`);
    chmodSync(binPath, 0o755);
    try {
      const tool = createSubprocessAgentInboxTool(binPath);
      const result = await tool.deliver({
        identity: {
          agentName: "matrix-bridge-fanout",
          scopes: ["inbox.deliver"] as const,
          correlationId: "x",
          issuer: "test-gateway",
          expiresAt: 0,
        },
        toSession: "hostname-null-codex-app",
        body: "duplicate fanout",
        idempotencyKey: "$evt-abc:hostname-null-codex-app",
        kind: "matrix_room_mention",
      });
      expect(result.message_id).toBe("msg-existing-1");
      expect(result.already_delivered).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  /**
   * WHAT: `parseMatrixOriginEnvelope` accepts a fully-formed envelope,
   *       accepts the optional `reply_to_event_id` when present, and
   *       rejects malformed input (missing required field, wrong type)
   *       by returning undefined.
   * WHY:  Pre-contract rows have no `matrixOrigin` field; CLI predating
   *       v0.2 emits nothing. Defensive parse keeps the read-side
   *       InboxMessage shape valid (no partial envelopes leaking with
   *       missing required fields).
   */
  test("parseMatrixOriginEnvelope: valid + reply-threaded + malformed shapes", () => {
    expect(parseMatrixOriginEnvelope(undefined)).toBeUndefined();
    expect(parseMatrixOriginEnvelope(null)).toBeUndefined();
    expect(parseMatrixOriginEnvelope({})).toBeUndefined();
    expect(parseMatrixOriginEnvelope({ event_id: "x" })).toBeUndefined();
    expect(
      parseMatrixOriginEnvelope({
        event_id: "$x",
        room_id: "!r",
        sender: "@u",
        // wrong type: string instead of number
        origin_server_ts: "1748263200000",
      }),
    ).toBeUndefined();

    const minimal = parseMatrixOriginEnvelope({
      event_id: "$x",
      room_id: "!r",
      sender: "@u",
      origin_server_ts: 1748263200000,
    });
    expect(minimal).toEqual({
      event_id: "$x",
      room_id: "!r",
      sender: "@u",
      origin_server_ts: 1748263200000,
    });

    const threaded = parseMatrixOriginEnvelope({
      event_id: "$x",
      room_id: "!r",
      sender: "@u",
      origin_server_ts: 1748263200000,
      reply_to_event_id: "$prev",
    });
    expect(threaded?.reply_to_event_id).toBe("$prev");
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
    const wireup = await setupAgentsMcpMount({
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

  // ============================================================
  // AJS-55 MINT ENDPOINTS — P2 coverage per malar-codex-app review
  // ============================================================

  /**
   * Test helper: builds an in-memory PeerKeyDirectory + signs a
   * challenge-redeem request from the entity's private key. Avoids
   * filesystem I/O so tests are deterministic + fast.
   */
  async function makeMintFixture(opts: {
    entity: string;
    capabilities: { scopes: string[]; matrix?: { room: string }; inbox?: { session: string } };
  }): Promise<{
    peerKeyDirectory: import("@agents-js/host").PeerKeyDirectory;
    signChallenge: (challenge: string, requested_scopes: string[]) => string;
  }> {
    // @internal ed25519 helpers + buildChallengeMintSignedBytes — public
    // surface from the host barrel; direct src import for the internal
    // helpers keeps them @internal for npm consumers.
    const { buildChallengeMintSignedBytes } = await import("@agents-js/host");
    const { generateEd25519KeyPair, bytesToBase64 } = await import(
      "../../../packages/host/src/ed25519.ts"
    );
    const { createPrivateKey, sign: nodeSign } = await import("node:crypto");
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
    // Extract raw 32-byte pubkey from SPKI PEM for the PeerKeyDirectory.
    const { createPublicKey } = await import("node:crypto");
    const pubKey = createPublicKey(publicKeyPem);
    const spkiDer = pubKey.export({ type: "spki", format: "der" });
    const rawPubKey = new Uint8Array(spkiDer.subarray(spkiDer.length - 32));
    const pubKeyBase64 = bytesToBase64(rawPubKey);
    const priv = createPrivateKey(privateKeyPem);
    const entity = opts.entity;
    return {
      peerKeyDirectory: {
        getPubkey: (e) => (e === entity ? pubKeyBase64 : null),
        getCapabilities: (e) => (e === entity ? { scopes: opts.capabilities.scopes } : null),
      },
      signChallenge: (challenge, requested_scopes) => {
        const signedBytes = buildChallengeMintSignedBytes({
          challenge,
          entity,
          requested_scopes,
        });
        const sig = nodeSign(null, signedBytes, priv);
        return bytesToBase64(new Uint8Array(sig));
      },
    };
  }

  /**
   * WHAT: AGENTS_MCP_TRUST_MANIFEST_PATH + AGENTS_MCP_TRUST_ROOT_PATH env
   *       config makes /api/agents/mint/challenge reachable through the
   *       REAL production setup path, with NO `peerKeyDirectory` override.
   *       Real temp files for manifest + trust-root + signed peer record.
   *       Returns 200 with challenge + expires_at.
   * WHY: This is the actual regression test for malar-codex-app's
   *      original P1 finding (`bb94de15` re-review). The OTHER test in
   *      this file titled "with wired peerKeyDirectory" uses the
   *      override seam — it pins the impl shape but does NOT exercise
   *      the env→endpoint chain. THIS test does, by going through
   *      `readAgentsMcpEnv → setupAgentsMcpMount → watchTrustManifest`
   *      end-to-end. If the env-parse or auto-wire regresses, this test
   *      goes red; the override test stays green.
   *
   *      Cleanup: wireup.stop() releases the fs.watch handle so the
   *      test process doesn't hang on teardown. Temp dir rm'd after.
   */
  test("AJS-55 P1 regression: env paths through real setup → /mint/challenge 200 (NO peerKeyDirectory override)", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { generateEd25519KeyPair, bytesToBase64 } = await import(
      "../../../packages/host/src/ed25519.ts"
    );
    const { signPeerRecord } = await import("@agents-js/host");

    const tmpDir = mkdtempSync(join(tmpdir(), "ajs55-env-test-"));
    let wireup: Awaited<ReturnType<typeof setupAgentsMcpMount>> = null;
    try {
      const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
      const trustRootPath = join(tmpDir, "trust-root.pub");
      writeFileSync(trustRootPath, publicKeyPem, "utf-8");

      // Signed peer record. Pubkey is raw base64 32-byte (B1 contract).
      const peerKeyPair = generateEd25519KeyPair();
      const { createPublicKey } = await import("node:crypto");
      const peerPubKey = createPublicKey(peerKeyPair.publicKeyPem);
      const peerSpkiDer = peerPubKey.export({ type: "spki", format: "der" });
      const peerPubKeyRaw = bytesToBase64(
        new Uint8Array(peerSpkiDer.subarray(peerSpkiDer.length - 32)),
      );
      const signedRecord = signPeerRecord(
        {
          entity: "env-test-peer",
          pubkey: peerPubKeyRaw,
          capabilities: { scopes: ["matrix.send_message"] },
          signed_at: "2026-05-23T12:00:00Z",
          signer: "fleet-root",
        },
        privateKeyPem,
      );
      const recordPath = join(tmpDir, "env-test-peer.signed.json");
      writeFileSync(recordPath, JSON.stringify(signedRecord), "utf-8");

      const manifestPath = join(tmpDir, "trust.json");
      writeFileSync(
        manifestPath,
        JSON.stringify({ peers: [{ entity: "env-test-peer", record_path: recordPath }] }),
        "utf-8",
      );

      // CRITICAL: pass ENV ONLY. NO peerKeyDirectory override. NO
      // challengeStore override. If env-wire regresses, this test goes red
      // because /mint/challenge returns 503 instead of 200.
      wireup = await setupAgentsMcpMount({
        overrides: {
          env: {
            AGENTS_MCP_JWT_SIGNING_KEY: SIGNING_KEY_TEXT,
            AGENTS_MCP_JWT_ISSUER: ISSUER,
            AGENTS_MCP_SEND_SCRIPT: "/unused-in-test",
            AGENTS_MCP_TRUST_MANIFEST_PATH: manifestPath,
            AGENTS_MCP_TRUST_ROOT_PATH: trustRootPath,
          },
          // Subprocess matrix tool needs a no-op override to avoid spawning
          // the real send-matrix script (which would fail at /unused-in-test).
          matrixTool: makeRecordingMatrixTool(),
        },
      });
      if (wireup === null) throw new Error("setupAgentsMcpMount returned null with env set");

      const res = await wireup.fetchHandler(
        new Request("http://gw.local/api/agents/mint/challenge", { method: "POST" }),
      );
      // The original P1 bug: this returned 503. The fix: env wire makes
      // it return 200. If this assertion fails again, the auto-wire
      // regressed (or got reverted to override-only behavior).
      expect(res?.status).toBe(200);
      const body = (await res?.json()) as { challenge: string; expires_at: number };
      expect(typeof body.challenge).toBe("string");
      expect(body.expires_at).toBeGreaterThan(Date.now());
    } finally {
      // Release fs.watch handle so the test process can exit.
      wireup?.stop();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  /**
   * WHAT: Trust-manifest override path (via `peerKeyDirectory` override
   *       seam) makes /api/agents/mint/challenge reachable. Returns 200
   *       with challenge + expires_at.
   * WHY: Pins the impl shape (challengeStore + ipRateLimiter auto-create
   *      when peerKeyDirectory is non-null). NOT a regression test for
   *      the env→endpoint chain — see the test above for that.
   */
  test("AJS-55: /mint/challenge with override peerKeyDirectory → 200 with challenge + expires_at", async () => {
    const fixture = await makeMintFixture({
      entity: "test-peer",
      capabilities: { scopes: ["matrix.send_message"] },
    });
    const wireup = await setupAgentsMcpMount({
      overrides: {
        config: baseConfig(),
        matrixTool: makeRecordingMatrixTool(),
        peerKeyDirectory: fixture.peerKeyDirectory,
      },
    });
    if (wireup === null) throw new Error("unreachable");
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/mint/challenge", { method: "POST" }),
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { challenge: string; expires_at: number };
    expect(typeof body.challenge).toBe("string");
    expect(body.challenge.length).toBeGreaterThanOrEqual(43);
    expect(body.expires_at).toBeGreaterThan(Date.now());
  });

  /**
   * WHAT: Full challenge → redeem happy path returns a JWT that
   *       successfully calls /api/agents/send_message.
   * WHY: End-to-end production-path proof. Pins the contract Jens cares
   *      about: peer signs challenge → gets JWT → uses JWT to call
   *      tools, all via canonical endpoints.
   */
  test("AJS-55: challenge → sign → redeem → JWT bearer happy path", async () => {
    const fixture = await makeMintFixture({
      entity: "test-peer",
      capabilities: { scopes: ["matrix.send_message", "inbox.deliver"] },
    });
    const matrix = makeRecordingMatrixTool();
    const inbox = makeRecordingInboxTool();
    const wireup = await setupAgentsMcpMount({
      overrides: {
        config: baseConfig({
          targets: {
            "ajs-claude": {
              matrix: { room: "!ajs:matrix.example" },
              inbox: { session: "ajs-claude" },
            },
          },
        }),
        matrixTool: matrix,
        agentInboxTool: inbox,
        peerKeyDirectory: fixture.peerKeyDirectory,
      },
    });
    if (wireup === null) throw new Error("unreachable");
    // 1. Get challenge.
    const challengeRes = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/mint/challenge", { method: "POST" }),
    );
    expect(challengeRes?.status).toBe(200);
    const { challenge } = (await challengeRes?.json()) as { challenge: string };
    // 2. Sign + redeem.
    const sig = fixture.signChallenge(challenge, ["matrix.send_message", "inbox.deliver"]);
    const redeemRes = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/mint/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challenge,
          entity: "test-peer",
          requested_scopes: ["matrix.send_message", "inbox.deliver"],
          sig,
        }),
      }),
    );
    expect(redeemRes?.status).toBe(200);
    const { jwt, sub, scopes } = (await redeemRes?.json()) as {
      jwt: string;
      sub: string;
      scopes: string[];
    };
    expect(sub).toBe("test-peer");
    expect(scopes).toEqual(["matrix.send_message", "inbox.deliver"]);
    // 3. Use the minted JWT to call send_message.
    const sendRes = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/send_message", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ target: "ajs-claude", body: "minted via AJS-55" }),
      }),
    );
    expect(sendRes?.status).toBe(200);
    expect(inbox.delivers).toHaveLength(1);
  });

  /**
   * WHAT: Redeem with invalid signature → 401 invalid-signature.
   * WHY: Crypto verification gate; without this, fabricated sigs could
   *      mint JWTs (catastrophic).
   */
  test("AJS-55: /mint/redeem with invalid sig → 401 invalid-signature", async () => {
    const fixture = await makeMintFixture({
      entity: "test-peer",
      capabilities: { scopes: ["matrix.send_message"] },
    });
    const wireup = await setupAgentsMcpMount({
      overrides: {
        config: baseConfig(),
        matrixTool: makeRecordingMatrixTool(),
        peerKeyDirectory: fixture.peerKeyDirectory,
      },
    });
    if (wireup === null) throw new Error("unreachable");
    const challengeRes = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/mint/challenge", { method: "POST" }),
    );
    const { challenge } = (await challengeRes?.json()) as { challenge: string };
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/mint/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challenge,
          entity: "test-peer",
          requested_scopes: ["matrix.send_message"],
          // 64 zero bytes base64 = clearly invalid sig.
          sig: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        }),
      }),
    );
    expect(res?.status).toBe(401);
  });

  /**
   * WHAT: Redeem with unknown entity → 404 unknown-entity.
   * WHY: Trust manifest is the entity source-of-truth; entities not in
   *      manifest cannot mint.
   */
  test("AJS-55: /mint/redeem with unknown entity → 404 unknown-entity", async () => {
    const fixture = await makeMintFixture({
      entity: "test-peer",
      capabilities: { scopes: ["matrix.send_message"] },
    });
    const wireup = await setupAgentsMcpMount({
      overrides: {
        config: baseConfig(),
        matrixTool: makeRecordingMatrixTool(),
        peerKeyDirectory: fixture.peerKeyDirectory,
      },
    });
    if (wireup === null) throw new Error("unreachable");
    const challengeRes = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/mint/challenge", { method: "POST" }),
    );
    const { challenge } = (await challengeRes?.json()) as { challenge: string };
    const sig = fixture.signChallenge(challenge, ["matrix.send_message"]);
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/mint/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challenge,
          entity: "ghost-entity-not-in-manifest",
          requested_scopes: ["matrix.send_message"],
          sig,
        }),
      }),
    );
    expect(res?.status).toBe(404);
    const body = (await res?.json()) as { reason: string };
    expect(body.reason).toBe("unknown-entity");
  });

  /**
   * WHAT: Redeem with requested_scopes ⊄ entity capabilities → 400
   *       invalid-scope with offending_scopes field. No silent downgrade.
   * WHY: cognee-codex primary fix #2 (AJS-55 vault doc). Caller asking
   *      for more scopes than their entity has must FAIL, not get a
   *      downgraded JWT.
   */
  test("AJS-55: /mint/redeem with over-scoped request → 400 invalid-scope + offending_scopes (no silent downgrade)", async () => {
    const fixture = await makeMintFixture({
      entity: "limited-peer",
      capabilities: { scopes: ["matrix.send_message"] }, // entity has only one scope
    });
    const wireup = await setupAgentsMcpMount({
      overrides: {
        config: baseConfig(),
        matrixTool: makeRecordingMatrixTool(),
        peerKeyDirectory: fixture.peerKeyDirectory,
      },
    });
    if (wireup === null) throw new Error("unreachable");
    const challengeRes = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/mint/challenge", { method: "POST" }),
    );
    const { challenge } = (await challengeRes?.json()) as { challenge: string };
    // Request a scope not in the entity's capabilities.
    const sig = fixture.signChallenge(challenge, ["matrix.send_message", "inbox.read_all"]);
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/mint/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challenge,
          entity: "limited-peer",
          requested_scopes: ["matrix.send_message", "inbox.read_all"],
          sig,
        }),
      }),
    );
    expect(res?.status).toBe(400);
    const body = (await res?.json()) as { reason: string; offending_scopes: string[] };
    expect(body.reason).toBe("invalid-scope");
    expect(body.offending_scopes).toEqual(["inbox.read_all"]);
  });

  /**
   * WHAT: Replaying a successfully-redeemed challenge → 401 with
   *       reason invalid-challenge (already-redeemed).
   * WHY: Single-use semantics protect against capture-replay attacks
   *      where an attacker intercepts a valid signed challenge.
   */
  test("AJS-55: /mint/redeem replay → 401 invalid-challenge", async () => {
    const fixture = await makeMintFixture({
      entity: "test-peer",
      capabilities: { scopes: ["matrix.send_message"] },
    });
    const wireup = await setupAgentsMcpMount({
      overrides: {
        config: baseConfig(),
        matrixTool: makeRecordingMatrixTool(),
        peerKeyDirectory: fixture.peerKeyDirectory,
      },
    });
    if (wireup === null) throw new Error("unreachable");
    const challengeRes = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/mint/challenge", { method: "POST" }),
    );
    const { challenge } = (await challengeRes?.json()) as { challenge: string };
    const sig = fixture.signChallenge(challenge, ["matrix.send_message"]);
    const req = () =>
      wireup.fetchHandler(
        new Request("http://gw.local/api/agents/mint/redeem", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            challenge,
            entity: "test-peer",
            requested_scopes: ["matrix.send_message"],
            sig,
          }),
        }),
      );
    // First redeem succeeds.
    expect((await req())?.status).toBe(200);
    // Replay rejected.
    const replayRes = await req();
    expect(replayRes?.status).toBe(401);
    const body = (await replayRes?.json()) as { reason: string; message: string };
    expect(body.reason).toBe("invalid-challenge");
    expect(body.message).toContain("already-redeemed");
  });

  /**
   * WHAT: Per-IP rate limit on /mint/challenge → 429 with Retry-After
   *       once burst exhausted.
   * WHY: Prevents an attacker flooding the unauthenticated mint endpoint
   *      to exhaust the challenge store. Caps + token bucket together
   *      bound the attack surface.
   */
  test("AJS-55: /mint/challenge rate limit exhausts → 429 with Retry-After", async () => {
    const fixture = await makeMintFixture({
      entity: "test-peer",
      capabilities: { scopes: ["matrix.send_message"] },
    });
    const { createIpRateLimiter } = await import("@agents-js/host");
    const wireup = await setupAgentsMcpMount({
      overrides: {
        config: baseConfig(),
        matrixTool: makeRecordingMatrixTool(),
        peerKeyDirectory: fixture.peerKeyDirectory,
        // Tight limiter to make test deterministic.
        ipRateLimiter: createIpRateLimiter({ ratePerMinute: 30, burst: 2 }),
      },
    });
    if (wireup === null) throw new Error("unreachable");
    const req = () =>
      wireup.fetchHandler(
        new Request("http://gw.local/api/agents/mint/challenge", {
          method: "POST",
          headers: { "X-Forwarded-For": "192.0.2.99" },
        }),
      );
    // Burst capacity of 2 → 2 succeed.
    expect((await req())?.status).toBe(200);
    expect((await req())?.status).toBe(200);
    // 3rd request hits rate limit.
    const limited = await req();
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("Retry-After")).not.toBeNull();
  });

  /**
   * WHAT: AGENTS_MCP_DISABLE_ADMIN_MINT=1 → /api/agents/admin/mint
   *       returns 404 with migration message pointing at AJS-55 endpoints.
   * WHY: Migration kill-switch. Once operators have migrated to challenge
   *      mint, they flip this env var to hard-disable the legacy endpoint.
   */
  test("AJS-55: AGENTS_MCP_DISABLE_ADMIN_MINT=1 → /admin/mint returns 404", async () => {
    const originalEnv = Bun.env.AGENTS_MCP_DISABLE_ADMIN_MINT;
    try {
      Bun.env.AGENTS_MCP_DISABLE_ADMIN_MINT = "1";
      const wireup = await setupAgentsMcpMount({
        overrides: {
          config: baseConfig({ adminToken: ADMIN_TOKEN }),
          matrixTool: makeRecordingMatrixTool(),
        },
      });
      if (wireup === null) throw new Error("unreachable");
      const res = await wireup.fetchHandler(
        new Request("http://gw.local/api/agents/admin/mint", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Admin ${ADMIN_TOKEN}` },
          body: JSON.stringify({ sub: "x", cid: "y" }),
        }),
      );
      expect(res?.status).toBe(404);
      const body = (await res?.json()) as { error: string };
      expect(body.error).toContain("AJS-55");
      expect(body.error).toContain("mint/challenge");
    } finally {
      if (originalEnv === undefined) {
        delete Bun.env.AGENTS_MCP_DISABLE_ADMIN_MINT;
      } else {
        Bun.env.AGENTS_MCP_DISABLE_ADMIN_MINT = originalEnv;
      }
    }
  });
});

describe("buildDispatchTargetDirectory — env override + trust-derived fallback (AJS-65)", () => {
  const trustOnly = {
    resolve: (t: string) => (t === "trust-peer" ? { matrix: { room: "!trust:hs" } } : null),
    entries: () =>
      [["trust-peer", { matrix: { room: "!trust:hs" } }]] as ReadonlyArray<
        readonly [string, { matrix?: { room: string }; inbox?: { session: string } }]
      >,
  };

  test("env config.targets takes precedence (operator override)", () => {
    const td = buildDispatchTargetDirectory(
      { "trust-peer": { matrix: { room: "!env:hs" } } },
      trustOnly,
    );
    expect(td.resolve("trust-peer")).toEqual({ matrix: { room: "!env:hs" } });
  });

  test("falls back to trust-derived directory when absent from env targets (send-404 fix)", () => {
    const td = buildDispatchTargetDirectory({}, trustOnly);
    expect(td.resolve("trust-peer")).toEqual({ matrix: { room: "!trust:hs" } });
  });

  test("returns null when neither env nor trust resolves the target", () => {
    const td = buildDispatchTargetDirectory({}, trustOnly);
    expect(td.resolve("unknown")).toBeNull();
  });

  test("back-compat: no trust directory → env targets only", () => {
    const td = buildDispatchTargetDirectory({ a: { matrix: { room: "!a" } } }, null);
    expect(td.resolve("a")).toEqual({ matrix: { room: "!a" } });
    expect(td.resolve("trust-peer")).toBeNull();
  });

  // ---- BL-54: entries() unions both sources, env wins collision ----

  test("entries() unions env targets + trust directory", () => {
    const td = buildDispatchTargetDirectory(
      { "env-peer": { matrix: { room: "!env:hs" } } },
      trustOnly,
    );
    const names = td
      .entries()
      .map(([name]) => name)
      .sort();
    expect(names).toEqual(["env-peer", "trust-peer"]);
  });

  test("entries() env override wins on name collision (mirrors resolve precedence)", () => {
    const td = buildDispatchTargetDirectory(
      { "trust-peer": { matrix: { room: "!env:hs" } } },
      trustOnly,
    );
    const collisions = td.entries().filter(([name]) => name === "trust-peer");
    // Single entry under the colliding name (no duplicate), env value wins.
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.[1]).toEqual({ matrix: { room: "!env:hs" } });
    // entries() and resolve() agree on the same target.
    expect(td.resolve("trust-peer")).toEqual({ matrix: { room: "!env:hs" } });
  });

  test("entries() back-compat: no trust directory → env targets only", () => {
    const td = buildDispatchTargetDirectory({ a: { matrix: { room: "!a" } } }, null);
    expect(td.entries()).toEqual([["a", { matrix: { room: "!a" } }]]);
  });

  test("entries() empty when both sources empty", () => {
    const td = buildDispatchTargetDirectory({}, null);
    expect(td.entries()).toEqual([]);
  });
});

describe("GET /api/agents/matrix-targets — BL-54 recognition-registry read surface", () => {
  test("missing bearer → 401 with WWW-Authenticate", async () => {
    const wireup = await setupAgentsMcpMount({
      overrides: { config: baseConfig(), matrixTool: makeRecordingMatrixTool() },
    });
    if (wireup === null) throw new Error("unreachable");
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/matrix-targets", { method: "GET" }),
    );
    expect(res?.status).toBe(401);
    expect(res?.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  test("valid JWT without matrix.targets.read scope → 403 scope-not-granted", async () => {
    const wireup = await setupAgentsMcpMount({
      overrides: { config: baseConfig(), matrixTool: makeRecordingMatrixTool() },
    });
    if (wireup === null) throw new Error("unreachable");
    const jwt = await mintTestJwt({ scopes: ["matrix.send_message"] });
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/matrix-targets", {
        method: "GET",
        headers: { Authorization: `Bearer ${jwt}` },
      }),
    );
    expect(res?.status).toBe(403);
    const json = (await res?.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe("scope-not-granted");
  });

  test("valid JWT with matrix.targets.read → 200, enumerates matrix-routable targets", async () => {
    const wireup = await setupAgentsMcpMount({
      overrides: { config: baseConfig(), matrixTool: makeRecordingMatrixTool() },
    });
    if (wireup === null) throw new Error("unreachable");
    const jwt = await mintTestJwt({ scopes: ["matrix.targets.read"] });
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/matrix-targets", {
        method: "GET",
        headers: { Authorization: `Bearer ${jwt}` },
      }),
    );
    expect(res?.status).toBe(200);
    const json = (await res?.json()) as {
      ok: boolean;
      targets: Array<{ name: string; room: string }>;
    };
    expect(json.ok).toBe(true);
    const byName = Object.fromEntries(json.targets.map((t) => [t.name, t.room]));
    expect(byName["ajs-claude"]).toBe("!ajs:matrix.example");
    expect(byName["cognee-codex"]).toBe("!cog:matrix.example");
  });

  test("excludes inbox-only targets (no matrix room) from the view", async () => {
    const config = baseConfig({
      targets: {
        "matrix-peer": { matrix: { room: "!m:hs" }, inbox: { session: "matrix-peer" } },
        "inbox-only-peer": { inbox: { session: "inbox-only-peer" } },
      },
    });
    const wireup = await setupAgentsMcpMount({
      overrides: { config, matrixTool: makeRecordingMatrixTool() },
    });
    if (wireup === null) throw new Error("unreachable");
    const jwt = await mintTestJwt({ scopes: ["matrix.targets.read"] });
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/matrix-targets", {
        method: "GET",
        headers: { Authorization: `Bearer ${jwt}` },
      }),
    );
    expect(res?.status).toBe(200);
    const json = (await res?.json()) as {
      ok: boolean;
      targets: Array<{ name: string; room: string }>;
    };
    const names = json.targets.map((t) => t.name);
    expect(names).toContain("matrix-peer");
    expect(names).not.toContain("inbox-only-peer");
  });

  test("excludes degenerate empty-room targets (env-override defense-in-depth)", async () => {
    const config = baseConfig({
      targets: {
        "real-peer": { matrix: { room: "!real:hs" } },
        "empty-room-peer": { matrix: { room: "" } },
        "whitespace-room-peer": { matrix: { room: "   " } },
      },
    });
    const wireup = await setupAgentsMcpMount({
      overrides: { config, matrixTool: makeRecordingMatrixTool() },
    });
    if (wireup === null) throw new Error("unreachable");
    const jwt = await mintTestJwt({ scopes: ["matrix.targets.read"] });
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/matrix-targets", {
        method: "GET",
        headers: { Authorization: `Bearer ${jwt}` },
      }),
    );
    expect(res?.status).toBe(200);
    const json = (await res?.json()) as {
      ok: boolean;
      targets: Array<{ name: string; room: string }>;
    };
    expect(json.targets.map((t) => t.name)).toEqual(["real-peer"]);
  });

  test("non-GET (POST) → 405 Allow: GET", async () => {
    const wireup = await setupAgentsMcpMount({
      overrides: { config: baseConfig(), matrixTool: makeRecordingMatrixTool() },
    });
    if (wireup === null) throw new Error("unreachable");
    const jwt = await mintTestJwt({ scopes: ["matrix.targets.read"] });
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/api/agents/matrix-targets", {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
      }),
    );
    expect(res?.status).toBe(405);
    expect(res?.headers.get("Allow")).toBe("GET");
  });
});
