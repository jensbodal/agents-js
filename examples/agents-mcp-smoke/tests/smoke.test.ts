/**
 * LT-5 — Agents-MCP dispatch + read (identity-bound message routing).
 *
 * Foundational e2e regression for the `@agents-js/host` agents-MCP tool
 * surface: a downstream consumer mounts the dispatcher behind an HTTP
 * boundary, mints a scoped HS256 JWT, dispatches `agents.send_message`
 * to a recording inbox tool, then reads the message back via
 * `agents.get_messages` from the SAME identity. The scope-ACL (403) and
 * missing-bearer (401) denials are pinned alongside the happy path.
 *
 * Mirrors the gateway's `apps/internal-gateway/tests/agents-mcp-mount.test.ts`
 * patterns (jose HS256 `mintTestJwt`, recording inbox-tool isolation, a
 * small fetch-handler over the dispatcher) but reproduces them inline so
 * the example is self-contained against the package's PUBLIC surface — no
 * dependency on the gateway app's internal mount module. The dispatcher is
 * `@agents-js/host`'s `createAgentsDispatcher` (`agents-tool-surface.ts`).
 *
 * Identity binding is the core capability under test: the inbox `from`
 * session and the get_messages read session are BOTH server-resolved from
 * the verified JWT `sub`, never from request-body fields a caller controls.
 */

import { describe, expect, test } from "bun:test";
import {
  type AgentInboxTool,
  type AuthenticatedIdentity,
  createAgentsDispatcher,
  extractBearerToken,
  type GetMessagesArgs,
  type GetMessagesResult,
  type InboxDeliverArgs,
  type InboxMessage,
  type InboxReadArgs,
  type SendMessageArgs,
  type SendMessageResult,
  type TargetDirectory,
  verifyJwt,
} from "@agents-js/host";
import { makeRecordingMatrixTool, mintTestJwt } from "@agents-js/host/testing";

const SIGNING_KEY_TEXT = "lt5-smoke-signing-key-32bytes-or-more";
const ISSUER = "lt5-smoke-gateway";
const AUDIENCE = "agents-js-mcp";
const SIGNING_KEY = new TextEncoder().encode(SIGNING_KEY_TEXT);

const AGENT = "codex-hostname-null";

/**
 * Directory with a single self-addressed inbox-only target — the AJS-65
 * durable substrate. `AGENT` routes to its own inbox session so a single
 * identity can `send_message` then `get_messages` to round-trip the message
 * back, matching the v1 self-only-read contract (cross-agent read needs the
 * future `inbox.read_all` scope).
 */
const targetDirectory: TargetDirectory = {
  resolve(target) {
    return target === AGENT ? { inbox: { session: AGENT } } : null;
  },
  entries() {
    return [[AGENT, { inbox: { session: AGENT } }]];
  },
};

/**
 * Stateful in-memory inbox tool. Unlike the gateway test's pure recording
 * doubles, this one PERSISTS delivered messages keyed by `toSession` so the
 * send → get round-trip reads back the message that was actually delivered.
 * Identity is taken from the server-resolved `identity.agentName`, never from
 * any caller arg.
 */
function makeStatefulInboxTool(): AgentInboxTool & {
  delivers: InboxDeliverArgs[];
  reads: InboxReadArgs[];
} {
  const delivers: InboxDeliverArgs[] = [];
  const reads: InboxReadArgs[] = [];
  const mailboxes = new Map<string, InboxMessage[]>();
  let seq = 0;
  return {
    delivers,
    reads,
    async deliver(args) {
      delivers.push(args);
      seq += 1;
      const message_id = `msg-${seq}`;
      const created_at = "2026-06-08T00:00:00Z";
      const box = mailboxes.get(args.toSession) ?? [];
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
    async read(args) {
      reads.push(args);
      return mailboxes.get(args.session) ?? [];
    },
  };
}

/** Mint an HS256 JWT pinned to this smoke's key/issuer/audience + default agent. */
async function mintJwt(
  overrides: { sub?: string; scopes?: string[]; cid?: string } = {},
): Promise<string> {
  return mintTestJwt({
    sub: AGENT,
    scopes: ["inbox.deliver", "inbox.read"],
    cid: "cid-lt5-001",
    iss: ISSUER,
    aud: AUDIENCE,
    key: SIGNING_KEY,
    ...overrides,
  });
}

/**
 * Minimal agents-MCP HTTP boundary over the dispatcher. Reproduces the
 * verify → scope-status mapping the gateway mount applies, so the example
 * exercises the same 200/401/403 contract a real consumer relies on.
 */
function makeFetchHandler(inbox: AgentInboxTool): (req: Request) => Promise<Response | null> {
  const dispatcher = createAgentsDispatcher({
    matrixTool: makeRecordingMatrixTool(),
    agentInboxTool: inbox,
    targetDirectory,
  });
  const JSON_HEADERS = { "Content-Type": "application/json" } as const;

  async function authenticate(
    req: Request,
  ): Promise<{ ok: true; identity: AuthenticatedIdentity } | { ok: false; res: Response }> {
    const token = extractBearerToken(req.headers.get("Authorization"));
    if (token === null) {
      return {
        ok: false,
        res: new Response(JSON.stringify({ ok: false, error: "missing-bearer" }), {
          status: 401,
          headers: { ...JSON_HEADERS, "WWW-Authenticate": 'Bearer realm="agents-js-mcp"' },
        }),
      };
    }
    const verification = await verifyJwt(token, {
      signingKey: SIGNING_KEY,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (!verification.ok) {
      return {
        ok: false,
        res: new Response(JSON.stringify({ ok: false, error: verification.reason }), {
          status: 401,
          headers: JSON_HEADERS,
        }),
      };
    }
    return { ok: true, identity: verification.identity };
  }

  return async (req) => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/agents/")) return null;

    const auth = await authenticate(req);
    if (!auth.ok) return auth.res;

    if (url.pathname === "/api/agents/send_message") {
      const args = (await req.json()) as SendMessageArgs;
      const result: SendMessageResult = await dispatcher.sendMessage(args, auth.identity);
      const status = result.ok ? 200 : result.error === "scope-not-granted" ? 403 : 400;
      return new Response(JSON.stringify(result), { status, headers: JSON_HEADERS });
    }

    if (url.pathname === "/api/agents/get_messages") {
      const text = await req.text();
      const args = (text ? JSON.parse(text) : {}) as GetMessagesArgs;
      const result: GetMessagesResult = await dispatcher.getMessages(args, auth.identity);
      const status = result.ok
        ? 200
        : result.error === "scope-not-granted" || result.error === "forbidden-target"
          ? 403
          : 400;
      return new Response(JSON.stringify(result), { status, headers: JSON_HEADERS });
    }

    return new Response(JSON.stringify({ error: "unknown-route" }), {
      status: 404,
      headers: JSON_HEADERS,
    });
  };
}

describe("examples/agents-mcp-smoke", () => {
  /**
   * Intent: the full same-identity round-trip — the LT-5 core proof.
   * ONE minted JWT dispatches send_message (scope inbox.deliver) → the
   * inbox records the delivery with the JWT `sub` as `from` → the SAME
   * JWT's get_messages reads the message back. Dispatch + read are wired
   * end-to-end and identity is server-resolved at both boundaries (the
   * deliver `from` and the read session both derive from the JWT `sub`,
   * never from caller-supplied body fields).
   */
  test("send_message → get_messages round-trip with the same identity; identity server-resolved from JWT sub", async () => {
    const inbox = makeStatefulInboxTool();
    const handler = makeFetchHandler(inbox);
    const jwt = await mintJwt({ sub: AGENT, scopes: ["inbox.deliver", "inbox.read"] });

    const sendRes = await handler(
      new Request("http://gw.local/api/agents/send_message", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({
          target: AGENT,
          body: "hello from LT-5",
          // Attacker-controlled fields — MUST be ignored; identity comes from JWT.
          as_agent: "spoofed-agent",
          sender: "spoofed-sender",
        }),
      }),
    );
    expect(sendRes?.status).toBe(200);
    const send = (await sendRes?.json()) as { ok: boolean; inbox_message_id: string };
    expect(send.ok).toBe(true);
    expect(send.inbox_message_id).toBe("msg-1");
    expect(inbox.delivers).toHaveLength(1);
    expect(inbox.delivers[0]?.identity.agentName).toBe(AGENT);
    expect(inbox.delivers[0]?.toSession).toBe(AGENT);

    // Same identity reads its own mailbox back — the JWT `sub` is the read session.
    const getRes = await handler(
      new Request("http://gw.local/api/agents/get_messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({}),
      }),
    );
    expect(getRes?.status).toBe(200);
    const get = (await getRes?.json()) as { ok: boolean; messages: InboxMessage[] };
    expect(get.ok).toBe(true);
    expect(get.messages).toHaveLength(1);
    expect(get.messages[0]?.message_id).toBe("msg-1");
    expect(get.messages[0]?.body).toBe("hello from LT-5");
    // Identity binding: the delivered `from` is the JWT sub, NOT the spoofed
    // body field; the read session is the same JWT sub.
    expect(get.messages[0]?.from_session).toBe(AGENT);
    expect(get.messages[0]?.to_session).toBe(AGENT);
    expect(inbox.reads[0]?.session).toBe(AGENT);
  });

  /**
   * Intent: scope-ACL denial. A valid JWT lacking `inbox.deliver` cannot
   * dispatch to an inbox-routed target — inbox is the mandatory durable
   * substrate, so its scope is always required. 403 (not 401): the token
   * is valid; the call is just unauthorized. The inbox tool is NOT touched.
   */
  test("send_message without inbox.deliver scope → 403 scope-not-granted; inbox not called", async () => {
    const inbox = makeStatefulInboxTool();
    const handler = makeFetchHandler(inbox);
    const jwt = await mintJwt({ scopes: ["inbox.read"] });
    const res = await handler(
      new Request("http://gw.local/api/agents/send_message", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ target: AGENT, body: "denied" }),
      }),
    );
    expect(res?.status).toBe(403);
    const json = (await res?.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe("scope-not-granted");
    expect(inbox.delivers).toHaveLength(0);
  });

  /**
   * Intent: missing-bearer denial. No Authorization header → 401 with the
   * RFC 6750 `WWW-Authenticate: Bearer` challenge, before any dispatch.
   */
  test("send_message without bearer → 401 missing-bearer + WWW-Authenticate", async () => {
    const inbox = makeStatefulInboxTool();
    const handler = makeFetchHandler(inbox);
    const res = await handler(
      new Request("http://gw.local/api/agents/send_message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: AGENT, body: "no auth" }),
      }),
    );
    expect(res?.status).toBe(401);
    expect(res?.headers.get("WWW-Authenticate")).toContain("Bearer");
    const json = (await res?.json()) as { error: string };
    expect(json.error).toBe("missing-bearer");
    expect(inbox.delivers).toHaveLength(0);
  });
});
