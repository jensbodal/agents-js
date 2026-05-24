/**
 * AJS-56 Phase 1 first-slice — `agents.send_message` dispatcher contract.
 *
 * Behavior tests, not implementation tests. These pin the FIVE
 * review criteria @cognee-codex pre-committed to at PR review time
 * (matrix event `$_-xjwRAihY3UjXMl-jtUQG0CTfJqrv185c56o7QdsPo`):
 *
 *   1. Working `agents.send_message` vertical path → Matrix
 *   2. Server-resolved identity (no caller-supplied `as_agent`)
 *   3. Unknown target → predictable structured error
 *   4. Provider.send called with server-resolved identity
 *   5. No admin Matrix tools exposed through the general provider
 *
 * Plus a few additional pinned-properties (scope enforcement, send-
 * failure containment, missing-required-arg validation) that the
 * MCP transport layer will rely on at integration time.
 *
 * Substrate prerequisites STUBBED per Jens's directive:
 *  - `TargetDirectory.resolve` is an in-memory stub here; the AJS-55
 *    trust-manifest loader will replace this with verified peer records.
 *  - `MatrixTool.send` is a recording stub here; the agents-mcp-mount
 *    wires it to the real subprocess (see agents-mcp-mount.test.ts).
 */

import { describe, expect, test } from "bun:test";
import {
  type AgentInboxTool,
  type AgentsDispatcher,
  createAgentsDispatcher,
  isFanOutSendResult,
  type MatrixSendArgs,
  type MatrixTool,
  type SendMessageArgs,
  type SendMessageResult,
  type TargetDirectory,
} from "../src/agents-tool-surface.ts";

import type { AuthenticatedIdentity } from "../src/jwt-verifier.ts";

/**
 * Test helper: narrow a {@link SendMessageResult} to the single-target
 * success shape. After AJS-63 widened the result type with a multi-target
 * variant, single-target tests need to assert "ok AND not fan-out" to
 * access the top-level `inbox_message_id` / `event_id` fields. This
 * helper centralises that two-step narrow + throw so each test stays
 * focused on the behavior it pins.
 */
// Single-target success branch — back-compat shape preserved across AJS-63.
type SingleTargetSuccess = Exclude<
  Extract<SendMessageResult, { ok: true }>,
  { results: unknown[] }
>;

function expectSingleTargetSuccess(
  result: SendMessageResult,
): asserts result is SingleTargetSuccess {
  if (!result.ok) {
    throw new Error(`expected ok=true; got error=${result.error} message=${result.message}`);
  }
  if (isFanOutSendResult(result)) {
    throw new Error("expected single-target shape; got fan-out result");
  }
}

function identity(opts: Partial<AuthenticatedIdentity> = {}): AuthenticatedIdentity {
  return {
    agentName: opts.agentName ?? "codex-hostname-null",
    scopes: opts.scopes ?? ["matrix.send_message", "matrix.read"],
    correlationId: opts.correlationId ?? "cid-test-001",
    issuer: opts.issuer ?? "proxmox-gw",
    expiresAt: opts.expiresAt ?? Math.floor(Date.now() / 1000) + 900,
  };
}

/**
 * In-memory TargetDirectory stub. Real AJS-55 trust manifest will
 * resolve from signed peer records loaded at gateway startup;
 * v1 stub takes a simple Map for test isolation.
 */
function makeTargetDirectory(
  entries: Record<string, { matrix?: { room: string }; inbox?: { session: string } }>,
): TargetDirectory {
  return {
    resolve(target: string) {
      return entries[target] ?? null;
    },
  };
}

/**
 * Recording MatrixTool stub. Captures every send call so tests can
 * assert on the EXACT identity / room / body the dispatcher passed,
 * without exercising real subprocess machinery.
 */
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

function makeDispatcher(opts?: {
  matrixTool?: MatrixTool;
  agentInboxTool?: AgentInboxTool;
  targetDirectory?: TargetDirectory;
}): AgentsDispatcher {
  return createAgentsDispatcher({
    matrixTool: opts?.matrixTool ?? makeRecordingMatrixTool(),
    ...(opts?.agentInboxTool ? { agentInboxTool: opts.agentInboxTool } : {}),
    targetDirectory:
      opts?.targetDirectory ??
      makeTargetDirectory({
        "ajs-claude": { matrix: { room: "!ajs:matrix.example" } },
        "cognee-codex": { matrix: { room: "!cog:matrix.example" } },
      }),
  });
}

describe("packages/host/tests/agents-tool-surface.test.ts — AJS-56 dispatcher contract", () => {
  /**
   * WHAT: A `sendMessage` call with valid identity, scope, and a target
   *       resolvable to a Matrix room returns `{ ok: true, event_id }`.
   * WHY: Positive path. Without this, every reject test below could
   *      pass while the dispatcher silently never reaches the provider —
   *      a "deny all" regression would be invisible.
   *
   * Maps to cognee-codex review criterion #1.
   */
  test("send_message with valid identity/scope/target → ok with event_id (matrix-only target back-compat)", async () => {
    const matrix = makeRecordingMatrixTool();
    const dispatcher = makeDispatcher({ matrixTool: matrix });
    const result = await dispatcher.sendMessage({ target: "ajs-claude", body: "hi" }, identity());
    expectSingleTargetSuccess(result);
    expect(result.event_id).toBe("$evt-1");
    // Matrix-only target has no inbox.session, so no inbox_message_id:
    expect(result.inbox_message_id).toBeUndefined();
    expect(matrix.calls).toHaveLength(1);
    expect(matrix.calls[0]?.room).toBe("!ajs:matrix.example");
    expect(matrix.calls[0]?.body).toBe("hi");
  });

  /**
   * WHAT: The `identity` arg passed to `MatrixTool.send` is the
   *       SERVER-RESOLVED identity (from the verified JWT), regardless
   *       of any `as_agent` / `sender` / `from` claim a caller might
   *       cram into the args object.
   * WHY: Maps DIRECTLY to cognee-codex review criteria #2 and #4 —
   *      "Caller identity is NOT accepted as user-supplied `as_agent`"
   *      + "Provider send called with server-resolved identity (not
   *      caller-asserted)." This is the core impersonation defense:
   *      a JWT verifies the caller as codex-hostname-null; an
   *      attacker who tried to inject `as_agent: "ajs-claude"` into
   *      the args MUST be ignored. The provider MUST see the JWT's
   *      sub, period.
   */
  test("server-resolved identity is propagated to MatrixTool; caller args cannot override", async () => {
    const matrix = makeRecordingMatrixTool();
    const dispatcher = makeDispatcher({ matrixTool: matrix });
    // Caller injects multiple impersonation-shaped fields into args.
    // The dispatcher signature does NOT include any of these — TS
    // would actually catch this at compile-time, but real callers
    // (the MCP transport) pass loose JSON, so the runtime check
    // matters too.
    const impersonationArgs = {
      target: "ajs-claude",
      body: "impersonation attempt",
      as_agent: "ajs-claude", // attacker-controlled
      sender: "ajs-claude", // attacker-controlled
      from: "ajs-claude", // attacker-controlled
      identity: { agentName: "ajs-claude" }, // attacker-controlled
    } as unknown as SendMessageArgs;
    await dispatcher.sendMessage(impersonationArgs, identity({ agentName: "codex-hostname-null" }));
    expect(matrix.calls).toHaveLength(1);
    expect(matrix.calls[0]?.identity.agentName).toBe("codex-hostname-null");
  });

  /**
   * WHAT: An unknown target (not in the directory) returns
   *       `{ ok: false, error: "unknown-target", target, correlation_id }`
   *       and does NOT call `MatrixTool.send`.
   * WHY: Maps to cognee-codex review criterion #3. Predictable
   *      structured error contract for unrouted calls — the MCP
   *      transport layer maps this to an HTTP 404 with the same
   *      `error` enum so observability can pivot on it. Critically,
   *      the provider is NOT called for an unresolved target;
   *      otherwise an attacker could side-channel detect target
   *      existence by timing the call.
   */
  test("unknown target → unknown-target error, target + correlation_id echoed, provider NOT called", async () => {
    const matrix = makeRecordingMatrixTool();
    const dispatcher = makeDispatcher({ matrixTool: matrix });
    const result = await dispatcher.sendMessage(
      { target: "does-not-exist", body: "hi" },
      identity({ correlationId: "cid-traceable-001" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("unknown-target");
    expect(result.target).toBe("does-not-exist");
    expect(result.correlation_id).toBe("cid-traceable-001");
    expect(matrix.calls).toHaveLength(0);
  });

  /**
   * WHAT: An identity that lacks `matrix.send_message` in its
   *       `scopes` is rejected with `error: "scope-not-granted"`
   *       and does NOT reach the provider.
   * WHY: ACL enforcement at dispatch time. Per AJS-56 design + AJS-57
   *      scope-ACL: even an authenticated identity without the
   *      specific tool scope MUST be rejected before provider
   *      invocation. Pin this in the dispatcher's contract; a
   *      regression that called the provider first and then "would
   *      have checked" would leak side effects.
   */
  test("identity without matrix.send_message scope → scope-not-granted, provider NOT called", async () => {
    const matrix = makeRecordingMatrixTool();
    const dispatcher = makeDispatcher({ matrixTool: matrix });
    const result = await dispatcher.sendMessage(
      { target: "ajs-claude", body: "hi" },
      identity({ scopes: ["matrix.read"] }), // no send_message
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("scope-not-granted");
    expect(matrix.calls).toHaveLength(0);
  });

  /**
   * WHAT: If `MatrixTool.send` throws, the dispatcher returns
   *       `{ ok: false, error: "send-failed", target, correlation_id, message }`
   *       and does NOT propagate the exception to the MCP transport.
   * WHY: Failure containment. The MCP transport must always be able
   *      to return a structured response to the caller — an
   *      uncaught exception would leak Node stack frames or 500
   *      generic errors. Per AJS-59's pattern (consumer's
   *      try/catch around the subprocess call), a single bad send
   *      MUST NOT take down the dispatcher.
   */
  test("MatrixTool.send throws → send-failed error, never propagates exception", async () => {
    const dispatcher = makeDispatcher({
      matrixTool: {
        async send() {
          throw new Error("matrix subprocess crashed");
        },
      },
    });
    const result = await dispatcher.sendMessage({ target: "ajs-claude", body: "hi" }, identity());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("send-failed");
    expect(result.message).toContain("matrix subprocess crashed");
  });

  /**
   * WHAT: Missing `target` arg → `{ error: "invalid-args" }`. Empty
   *       string `body: ""` is allowed (a sentinel for some legitimate
   *       caller patterns — e.g. "send a reaction with no body"). The
   *       dispatcher rejects only structural absence.
   * WHY: Args validation. The MCP tool definition documents required
   *      args; the dispatcher provides a defensive runtime check
   *      because the MCP SDK's tool-arg validation runs at the
   *      transport boundary, not here. Belt-and-suspenders for
   *      callers that bypass the transport (tests, dev tools).
   */
  test("missing target arg → invalid-args, never reaches provider", async () => {
    const matrix = makeRecordingMatrixTool();
    const dispatcher = makeDispatcher({ matrixTool: matrix });
    const result = await dispatcher.sendMessage(
      // biome-ignore lint/suspicious/noExplicitAny: test asserts dispatcher validates loose JSON args
      { body: "hi" } as any,
      identity(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("invalid-args");
    expect(matrix.calls).toHaveLength(0);
  });

  /**
   * WHAT: A directory entry that exists but has NO `matrix` routing
   *       (e.g. an inbox-only target, post-AJS-58) is rejected with
   *       `error: "unknown-target"` in v1 first-slice — because the
   *       AgentInbox backend is not implemented yet, "Matrix-less
   *       targets" are functionally unreachable.
   * WHY: Honest failure. The post-AJS-58 expected behavior is "route
   *      to AgentInbox," but v1 ships Matrix-only. Returning
   *      "unknown-target" rather than "send-failed" is the operator-
   *      friendly hint that the target needs Matrix routing
   *      registered. The AJS-58 PR will change this branch to
   *      route to the inbox; the contract change is documented as a
   *      breaking-fix in that PR's notes.
   */
  test("directory entry without matrix routing → unknown-target (AJS-58 will route to inbox)", async () => {
    const dispatcher = makeDispatcher({
      targetDirectory: makeTargetDirectory({
        "inbox-only-agent": {}, // exists but no .matrix
      }),
    });
    const result = await dispatcher.sendMessage(
      { target: "inbox-only-agent", body: "hi" },
      identity(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("unknown-target");
  });

  /**
   * WHAT: `reply_to_event_id` (when supplied as a string) is passed
   *       through to `MatrixTool.send` unchanged. Non-string values
   *       are dropped.
   * WHY: Reply threading is a real Matrix feature; the MCP tool
   *      contract should expose it. Pinning the passthrough
   *      separately catches a class of "arg accidentally renamed in
   *      transport, dispatcher silently dropped it" regressions.
   *      Strict-typing on the passthrough (string only) prevents
   *      arbitrary JSON from leaking into the subprocess args.
   */
  test("reply_to_event_id (string) passes through; non-string dropped", async () => {
    const matrix = makeRecordingMatrixTool();
    const dispatcher = makeDispatcher({ matrixTool: matrix });
    await dispatcher.sendMessage(
      { target: "ajs-claude", body: "thanks", reply_to_event_id: "$origEvent" },
      identity(),
    );
    expect(matrix.calls[0]?.replyToEventId).toBe("$origEvent");

    await dispatcher.sendMessage(
      // biome-ignore lint/suspicious/noExplicitAny: test asserts non-string reply id is dropped
      { target: "ajs-claude", body: "hi", reply_to_event_id: 12345 } as any,
      identity(),
    );
    expect(matrix.calls[1]?.replyToEventId).toBeUndefined();
  });

  /**
   * WHAT: The dispatcher exposes ONLY `sendMessage` for v1 first-slice.
   *       No admin tools (set_lead, invite_agent, poller_status) are
   *       reachable through any code path.
   * WHY: Maps to cognee-codex review criterion #5 — "No Matrix admin
   *      tools through the general provider." This is enforced at
   *      the TYPE level (TS won't compile a call to a method that
   *      isn't on the interface) AND verified at runtime by spec
   *      negative-existence. Future MatrixAdminProvider with stricter
   *      scopes is out of v1; pinning the absence here makes the
   *      addition deliberate.
   */
  test("dispatcher exposes only sendMessage + getMessages; no admin tool surface", () => {
    const dispatcher = makeDispatcher();
    expect(typeof dispatcher.sendMessage).toBe("function");
    expect(typeof dispatcher.getMessages).toBe("function");
    // Negative existence: keys of the dispatcher object are exactly
    // `["sendMessage", "getMessages"]`. Adding `setLead`, `inviteAgent`,
    // etc. would fail this assertion and signal the AC violation.
    expect(Object.keys(dispatcher).sort()).toEqual(["getMessages", "sendMessage"]);
  });

  // ──────────────────────────────────────────────────────────────────
  // AJS-58 AgentInboxProvider routing — new in this slice
  // ──────────────────────────────────────────────────────────────────

  /**
   * WHAT: A target whose directory entry has `inbox.session` (but no
   *       `matrix` route) is delivered through `AgentInboxTool.deliver`
   *       when the caller has `inbox.deliver` scope. Response carries
   *       `inbox_message_id` + `inbox_created_at`; no `event_id` (no
   *       matrix.room configured for this target).
   * WHY: Closes the gap PR #48 left as `unknown-target` for inbox-only
   *      agents. AJS-65 flat-fields shape replaces the prior `delivery`
   *      discriminator; consumers narrow on which optional field is
   *      present rather than a tag.
   */
  test("inbox-only target → AgentInboxTool.deliver invoked, returns inbox_message_id (no event_id)", async () => {
    const inboxCalls: Array<{ toSession: string; body: string; identity: AuthenticatedIdentity }> =
      [];
    const dispatcher = makeDispatcher({
      targetDirectory: makeTargetDirectory({ "ajs-claude": { inbox: { session: "ajs-claude" } } }),
      agentInboxTool: {
        async deliver(args) {
          inboxCalls.push({ toSession: args.toSession, body: args.body, identity: args.identity });
          return { message_id: "msg-abc-001", created_at: "2026-05-22T02:00:00Z" };
        },
        async read() {
          return [];
        },
      },
    });
    const result = await dispatcher.sendMessage(
      { target: "ajs-claude", body: "hi inbox" },
      identity({ scopes: ["inbox.deliver", "inbox.read"] }),
    );
    expectSingleTargetSuccess(result);
    expect(result.inbox_message_id).toBe("msg-abc-001");
    expect(result.inbox_created_at).toBe("2026-05-22T02:00:00Z");
    expect(result.event_id).toBeUndefined(); // no matrix.room for this target
    expect(inboxCalls).toHaveLength(1);
    expect(inboxCalls[0]?.toSession).toBe("ajs-claude");
    expect(inboxCalls[0]?.body).toBe("hi inbox");
    expect(inboxCalls[0]?.identity.agentName).toBe("codex-hostname-null");
  });

  /**
   * WHAT: A target with BOTH `matrix` and `inbox` routes, when the
   *       caller has both `matrix.send_message` and `inbox.deliver`
   *       scopes, has BOTH paths invoked. The response carries both
   *       `inbox_message_id` (durable storage) and `event_id` (matrix
   *       notification). No discriminator field — both fields are
   *       optional and either may be present.
   * WHY: AJS-65 route-model correction (Jens via codex-hostname-null
   *      2026-05-23T05:47 UTC, event $LaPSo1WDFUGT4xccWpsdrM130shpI8-hwExtQDi_J_I).
   *      Inbox is the durable delivery substrate; matrix is the
   *      notification + return-route overlay. Replaces the previous
   *      "matrix > inbox exclusive" precedence — that was a layering
   *      bug where matrix-wins suppressed durable storage. Reversing
   *      it back would re-introduce the failure mode that motivated
   *      AJS-65 (codex-hostname-null couldn't receive inbox-readable
   *      messages because matrix-wins skipped the inbox write).
   */
  test("target with both matrix + inbox, both scopes granted → BOTH called; matrix body is pointer-only (AJS-65 P2)", async () => {
    const matrix = makeRecordingMatrixTool();
    const inboxCalls: unknown[] = [];
    const dispatcher = makeDispatcher({
      matrixTool: matrix,
      targetDirectory: makeTargetDirectory({
        "ajs-claude": { matrix: { room: "!ajs:matrix.example" }, inbox: { session: "ajs-claude" } },
      }),
      agentInboxTool: {
        async deliver(args) {
          inboxCalls.push(args);
          return { message_id: "inbox-msg-001", created_at: "2026-05-23T07:30:00Z" };
        },
        async read() {
          return [];
        },
      },
    });
    const result = await dispatcher.sendMessage(
      { target: "ajs-claude", body: "full original body content" },
      identity({ scopes: ["matrix.send_message", "inbox.deliver"] }),
    );
    expectSingleTargetSuccess(result);
    // Inbox-write succeeded — full body lands in the durable substrate:
    expect(result.inbox_message_id).toBe("inbox-msg-001");
    expect(result.inbox_created_at).toBe("2026-05-23T07:30:00Z");
    expect(inboxCalls).toHaveLength(1);
    expect((inboxCalls[0] as { body: string }).body).toBe("full original body content");
    // Matrix-notify also succeeded:
    expect(result.event_id).toBe("$evt-1");
    expect(matrix.calls).toHaveLength(1);
    // P2 body-shape rule: matrix carries POINTER ONLY for dual-route.
    // Inbox is single source of truth; matrix is the wake signal.
    expect(matrix.calls[0]?.body).toBe("see inbox: inbox-msg-001");
    expect(matrix.calls[0]?.body).not.toBe("full original body content");
    // No matrix_notification_error since notification succeeded:
    expect(result.matrix_notification_error).toBeUndefined();
  });

  /**
   * WHAT: A target with BOTH matrix + inbox routes, when the caller has
   *       ONLY `matrix.send_message` scope (no inbox.deliver), returns
   *       `{ok:false, error:"scope-not-granted"}` naming inbox.deliver.
   *       Matrix is NOT called.
   * WHY: AJS-65 P1 contract blocker fix (malar-codex-app review on
   *       commit 6f21372a, event $61b0WXySzK4MONwCeSos2qVUJTDzxMbUjQ_IRf1_SqQ).
   *       Route presence determines required scope, not whichever scope
   *       the caller happens to carry. The earlier impl let matrix-only-
   *       scope callers bypass the inbox write entirely for dual-route
   *       targets — that was exactly the notification-without-storage
   *       failure mode AJS-65 is supposed to fix. Reversing it would
   *       re-introduce the bug that motivated the entire ticket.
   */
  test("AJS-65 P1: dual-route target + only matrix.send_message scope → scope-not-granted; matrix NOT called", async () => {
    const matrix = makeRecordingMatrixTool();
    const inboxCalls: unknown[] = [];
    const dispatcher = makeDispatcher({
      matrixTool: matrix,
      targetDirectory: makeTargetDirectory({
        "ajs-claude": { matrix: { room: "!ajs:matrix.example" }, inbox: { session: "ajs-claude" } },
      }),
      agentInboxTool: {
        async deliver(args) {
          inboxCalls.push(args);
          return { message_id: "should-not-be-used", created_at: "" };
        },
        async read() {
          return [];
        },
      },
    });
    const result = await dispatcher.sendMessage(
      { target: "ajs-claude", body: "matrix-only scope but target has inbox route" },
      identity({ scopes: ["matrix.send_message"] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false (P1: no bypass via missing inbox scope)");
    expect(result.error).toBe("scope-not-granted");
    expect(result.message).toContain("inbox.deliver");
    // CRITICAL: matrix MUST NOT have been called. The whole point of
    // AJS-65 is that matrix-only-scope must NOT bypass durable storage.
    expect(matrix.calls).toHaveLength(0);
    expect(inboxCalls).toHaveLength(0);
  });

  /**
   * WHAT: A target with BOTH matrix + inbox routes, when the caller
   *       has ONLY `inbox.deliver` scope (no matrix.send_message), is
   *       delivered through INBOX ONLY. Matrix notification is NOT
   *       fired because the caller lacks the matrix scope. Response
   *       carries inbox_message_id only (no event_id).
   * WHY: Per AJS-65 model, matrix.send_message is now an opt-in scope
   *      for the notification overlay. Without it, the durable inbox
   *      write still happens; only the matrix notification is
   *      suppressed. This is the right shape because inbox is the
   *      contract (durable substrate); matrix is best-effort overlay.
   */
  test("dual-route target + only inbox.deliver scope → inbox written, matrix NOT notified", async () => {
    const matrix = makeRecordingMatrixTool();
    const inboxCalls: unknown[] = [];
    const dispatcher = makeDispatcher({
      matrixTool: matrix,
      targetDirectory: makeTargetDirectory({
        "ajs-claude": { matrix: { room: "!ajs:matrix.example" }, inbox: { session: "ajs-claude" } },
      }),
      agentInboxTool: {
        async deliver(args) {
          inboxCalls.push(args);
          return { message_id: "msg-x", created_at: "2026-05-22T02:00:00Z" };
        },
        async read() {
          return [];
        },
      },
    });
    const result = await dispatcher.sendMessage(
      { target: "ajs-claude", body: "hi" },
      identity({ scopes: ["inbox.deliver"] }),
    );
    expectSingleTargetSuccess(result);
    expect(result.inbox_message_id).toBe("msg-x");
    expect(inboxCalls).toHaveLength(1);
    expect(result.event_id).toBeUndefined();
    expect(matrix.calls).toHaveLength(0);
  });

  /**
   * WHAT: A target with BOTH matrix + inbox routes, when the caller
   *       has BOTH scopes, but the matrix notification THROWS, returns
   *       a degraded success: `{ok:true, inbox_message_id, inbox_created_at,
   *       matrix_notification_error: "..."}`. HTTP 200, NOT 500.
   * WHY: AJS-65 failure semantics. Inbox is the durable contract; matrix
   *      is best-effort overlay. If inbox succeeds (the durable write
   *      took), the call is fundamentally successful — the recipient
   *      can read the message via agents.get_messages. Matrix's failure
   *      to fire the notification is surfaced as degraded info, not as
   *      a hard call failure.
   */
  test("matrix notify FAILS but inbox write succeeds → ok:true with matrix_notification_error (degraded)", async () => {
    const inboxCalls: unknown[] = [];
    const dispatcher = makeDispatcher({
      matrixTool: {
        async send() {
          throw new Error("matrix homeserver unreachable");
        },
      },
      targetDirectory: makeTargetDirectory({
        "ajs-claude": { matrix: { room: "!ajs:matrix.example" }, inbox: { session: "ajs-claude" } },
      }),
      agentInboxTool: {
        async deliver(args) {
          inboxCalls.push(args);
          return { message_id: "msg-degraded", created_at: "2026-05-23T07:35:00Z" };
        },
        async read() {
          return [];
        },
      },
    });
    const result = await dispatcher.sendMessage(
      { target: "ajs-claude", body: "hi" },
      identity({ scopes: ["matrix.send_message", "inbox.deliver"] }),
    );
    expectSingleTargetSuccess(result);
    expect(result.inbox_message_id).toBe("msg-degraded");
    expect(result.event_id).toBeUndefined();
    expect(result.matrix_notification_error).toContain("matrix homeserver unreachable");
    expect(inboxCalls).toHaveLength(1);
  });

  /**
   * WHAT: A target with BOTH matrix + inbox routes, when the caller has
   *       BOTH scopes, but the inbox WRITE throws, returns hard failure:
   *       `{ok:false, error:"inbox-write-failed", ...}`. Matrix
   *       notification MUST NOT be attempted because the durable write
   *       didn't take — notifying about a non-existent message would
   *       lie to the recipient.
   * WHY: AJS-65 failure semantics + AC#6 ordering: inbox-first, matrix-
   *      second, with hard-fail on inbox. The durable substrate is the
   *      contract; without storage, notification is meaningless.
   */
  test("inbox write FAILS → ok:false with inbox-write-failed; matrix NOT called", async () => {
    const matrix = makeRecordingMatrixTool();
    const dispatcher = makeDispatcher({
      matrixTool: matrix,
      targetDirectory: makeTargetDirectory({
        "ajs-claude": { matrix: { room: "!ajs:matrix.example" }, inbox: { session: "ajs-claude" } },
      }),
      agentInboxTool: {
        async deliver() {
          throw new Error("sqlite locked");
        },
        async read() {
          return [];
        },
      },
    });
    const result = await dispatcher.sendMessage(
      { target: "ajs-claude", body: "hi" },
      identity({ scopes: ["matrix.send_message", "inbox.deliver"] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.error).toBe("inbox-write-failed");
    expect(result.message).toContain("sqlite locked");
    // CRITICAL: matrix MUST NOT have been called — durable failed, no notification.
    expect(matrix.calls).toHaveLength(0);
  });

  /**
   * WHAT: A target with ONLY `inbox.session` (no matrix), when the
   *       caller has ONLY `matrix.send_message` scope (no inbox.deliver),
   *       is rejected with `scope-not-granted` whose `message` names
   *       `inbox.deliver`.
   * WHY: Diagnostic clarity. The caller's request is well-formed and
   *      the target exists; the only issue is they need a different
   *      scope. Telling them "scope inbox.deliver not granted" gives
   *      the operator the exact next action. Saying "unknown-target"
   *      would be both wrong (the target IS known) and unhelpful.
   */
  test("inbox-only target + caller without inbox.deliver → scope-not-granted naming inbox.deliver", async () => {
    const dispatcher = makeDispatcher({
      targetDirectory: makeTargetDirectory({ "ajs-claude": { inbox: { session: "ajs-claude" } } }),
      agentInboxTool: {
        async deliver() {
          throw new Error("should not be called");
        },
        async read() {
          return [];
        },
      },
    });
    const result = await dispatcher.sendMessage(
      { target: "ajs-claude", body: "hi" },
      identity({ scopes: ["matrix.send_message"] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("scope-not-granted");
    expect(result.message).toContain("inbox.deliver");
  });

  /**
   * WHAT: `AgentInboxTool.deliver` throwing is wrapped into
   *       `error: "send-failed"` with the underlying message,
   *       mirroring the matrix-send failure-containment contract.
   * WHY: Same failure-isolation guarantee Matrix has. The MCP transport
   *      always returns a structured response; a thrown subprocess
   *      error must NOT leak as a 500.
   */
  test("AgentInboxTool.deliver throws → inbox-write-failed wrapped error (AJS-65)", async () => {
    const dispatcher = makeDispatcher({
      targetDirectory: makeTargetDirectory({ "ajs-claude": { inbox: { session: "ajs-claude" } } }),
      agentInboxTool: {
        async deliver() {
          throw new Error("agent-msg subprocess crashed");
        },
        async read() {
          return [];
        },
      },
    });
    const result = await dispatcher.sendMessage(
      { target: "ajs-claude", body: "hi" },
      identity({ scopes: ["inbox.deliver"] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // AJS-65: inbox failures get the specific 'inbox-write-failed' reason
    // (was 'send-failed' in the matrix-or-inbox-exclusive era). Distinct
    // reason surfaces inbox-substrate problems vs other send failures.
    expect(result.error).toBe("inbox-write-failed");
    expect(result.message).toContain("agent-msg subprocess crashed");
  });

  // ──────────────────────────────────────────────────────────────────
  // AJS-58 getMessages — agents.get_messages MCP tool
  // ──────────────────────────────────────────────────────────────────

  /**
   * WHAT: `getMessages` with `inbox.read` scope and no `target` arg
   *       returns the identity's own inbox messages via
   *       `AgentInboxTool.read`. The session passed to the tool is
   *       `identity.agentName`, not anything from args.
   * WHY: Identity-bound read is the v1 contract (no cross-agent). A
   *      regression that passes an args-controlled `target` through
   *      would let any authenticated caller read any other agent's
   *      inbox — a serious privacy/security regression. Pin the
   *      server-resolved session here.
   */
  test("getMessages with inbox.read scope, no target → reads own session via AgentInboxTool", async () => {
    const readCalls: Array<{ session: string; limit?: number }> = [];
    const dispatcher = makeDispatcher({
      agentInboxTool: {
        async deliver() {
          throw new Error("not called in this test");
        },
        async read(args) {
          readCalls.push({
            session: args.session,
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
          });
          return [
            {
              message_id: "m1",
              from_session: "ajs-claude",
              to_session: "codex-hostname-null",
              created_at: "2026-05-22T01:00:00Z",
              body: "first",
            },
          ];
        },
      },
    });
    const result = await dispatcher.getMessages({}, identity({ scopes: ["inbox.read"] }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.body).toBe("first");
    expect(readCalls).toHaveLength(1);
    expect(readCalls[0]?.session).toBe("codex-hostname-null");
    expect(readCalls[0]?.limit).toBe(20);
  });

  /**
   * WHAT: `getMessages` without `inbox.read` scope returns
   *       `error: "scope-not-granted"` and does NOT call the inbox.
   * WHY: ACL enforcement contract mirror of sendMessage's scope check.
   *      The transport maps this to 403.
   */
  test("getMessages without inbox.read scope → scope-not-granted, inbox NOT called", async () => {
    const readCalls: unknown[] = [];
    const dispatcher = makeDispatcher({
      agentInboxTool: {
        async deliver() {
          throw new Error("not called");
        },
        async read(args) {
          readCalls.push(args);
          return [];
        },
      },
    });
    const result = await dispatcher.getMessages({}, identity({ scopes: ["inbox.deliver"] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("scope-not-granted");
    expect(readCalls).toHaveLength(0);
  });

  /**
   * WHAT: `getMessages({ target: "other-agent" })` when identity is
   *       `codex-hostname-null` returns `error: "forbidden-target"`
   *       and does NOT call the inbox.
   * WHY: Self-only read is the v1 hard contract. A future
   *      `inbox.read_all` scope will lift this restriction; v1 must
   *      reject explicitly rather than silently honoring the arg.
   *      The error message names the missing scope so operators have
   *      the actionable hint.
   */
  test("getMessages with target != identity → forbidden-target (no inbox call)", async () => {
    const readCalls: unknown[] = [];
    const dispatcher = makeDispatcher({
      agentInboxTool: {
        async deliver() {
          throw new Error("not called");
        },
        async read(args) {
          readCalls.push(args);
          return [];
        },
      },
    });
    const result = await dispatcher.getMessages(
      { target: "other-agent" },
      identity({ agentName: "codex-hostname-null", scopes: ["inbox.read"] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("forbidden-target");
    expect(result.message).toContain("inbox.read_all");
    expect(readCalls).toHaveLength(0);
  });

  /**
   * WHAT: `getMessages` when no `agentInboxTool` is configured returns
   *       `error: "read-failed"` with a clear "inbox substrate not
   *       configured" message.
   * WHY: Dev-mode guard. The gateway may be started without inbox
   *      env wired; rather than crashing or returning a confusing
   *      "no messages" empty array, surface the misconfig explicitly.
   */
  test("getMessages with no agentInboxTool configured → read-failed (not configured)", async () => {
    const dispatcher = makeDispatcher({}); // no agentInboxTool override
    const result = await dispatcher.getMessages({}, identity({ scopes: ["inbox.read"] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("read-failed");
    expect(result.message).toContain("not configured");
  });

  /**
   * WHAT: `AgentInboxTool.read` throwing returns
   *       `error: "read-failed"` with the underlying message, never
   *       propagates the exception.
   * WHY: Same failure-isolation contract as deliver. The transport
   *      layer always gets structured JSON.
   */
  test("AgentInboxTool.read throws → read-failed wrapped error", async () => {
    const dispatcher = makeDispatcher({
      agentInboxTool: {
        async deliver() {
          throw new Error("not called");
        },
        async read() {
          throw new Error("agent-msg read crashed");
        },
      },
    });
    const result = await dispatcher.getMessages({}, identity({ scopes: ["inbox.read"] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("read-failed");
    expect(result.message).toContain("agent-msg read crashed");
  });

  /**
   * WHAT: `getMessages({ limit: 5 })` passes through to
   *       `AgentInboxTool.read` as `limit: 5`. Invalid limits
   *       (negative, zero, non-numeric) fall back to the default 20.
   * WHY: Defense against malformed args. Non-positive limit could
   *      cause the substrate to return everything or error in an
   *      unexpected way; clamp to the well-defined default rather
   *      than propagating garbage.
   */
  test("getMessages limit passthrough; invalid limit falls back to default 20", async () => {
    const observed: number[] = [];
    const dispatcher = makeDispatcher({
      agentInboxTool: {
        async deliver() {
          throw new Error("not called");
        },
        async read(args) {
          observed.push(args.limit ?? -1);
          return [];
        },
      },
    });
    await dispatcher.getMessages({ limit: 5 }, identity({ scopes: ["inbox.read"] }));
    expect(observed[observed.length - 1]).toBe(5);
    // biome-ignore lint/suspicious/noExplicitAny: test asserts dispatcher clamps malformed limit
    await dispatcher.getMessages({ limit: -1 } as any, identity({ scopes: ["inbox.read"] }));
    expect(observed[observed.length - 1]).toBe(20);
    // biome-ignore lint/suspicious/noExplicitAny: test asserts dispatcher clamps non-numeric limit
    await dispatcher.getMessages({ limit: "abc" } as any, identity({ scopes: ["inbox.read"] }));
    expect(observed[observed.length - 1]).toBe(20);
  });
});
