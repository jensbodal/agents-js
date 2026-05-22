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
  type AgentsDispatcher,
  createAgentsDispatcher,
  type MatrixSendArgs,
  type MatrixTool,
  type SendMessageArgs,
  type TargetDirectory,
} from "../src/agents-tool-surface.ts";
import type { AuthenticatedIdentity } from "../src/jwt-verifier.ts";

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
  entries: Record<string, { matrix?: { room: string } }>,
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
  targetDirectory?: TargetDirectory;
}): AgentsDispatcher {
  return createAgentsDispatcher({
    matrixTool: opts?.matrixTool ?? makeRecordingMatrixTool(),
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
  test("send_message with valid identity/scope/target → ok with event_id from Matrix provider", async () => {
    const matrix = makeRecordingMatrixTool();
    const dispatcher = makeDispatcher({ matrixTool: matrix });
    const result = await dispatcher.sendMessage({ target: "ajs-claude", body: "hi" }, identity());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.event_id).toBe("$evt-1");
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
  test("dispatcher exposes only sendMessage; no admin tool surface", () => {
    const dispatcher = makeDispatcher();
    expect(typeof dispatcher.sendMessage).toBe("function");
    // Negative existence: keys of the dispatcher object are exactly
    // `["sendMessage"]`. Adding `setLead`, `inviteAgent`, etc. would
    // fail this assertion and signal the AC violation.
    expect(Object.keys(dispatcher)).toEqual(["sendMessage"]);
  });
});
