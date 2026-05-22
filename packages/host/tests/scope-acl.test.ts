/**
 * AJS-57 scope ACL — contract tests.
 *
 * The verifier (jwt-verifier.ts) confirms WHO the caller is.
 * The scope ACL confirms WHAT they're allowed to call. These are
 * intentionally separate concerns:
 *
 *  - Verifier rejection → 401 (auth failure)
 *  - Scope ACL rejection → 403 (auth ok, not permitted)
 *
 * Per AJS-56 design "Per-tool scope ACL enforcement (least-privilege;
 * reject if scope not in JWT claims)" — the dispatcher checks each
 * tool's required scope against the JWT's `scopes` claim before
 * invoking the provider.
 *
 * Tests pin the behavior contract: every accept path AND every reject
 * path must be visible to reviewers + auditors as a named test, with
 * a stated security rationale.
 */

import { describe, expect, test } from "bun:test";
import type { AuthenticatedIdentity } from "../src/jwt-verifier.ts";
import { checkScope } from "../src/scope-acl.ts";

function identity(scopes: readonly string[]): AuthenticatedIdentity {
  return {
    agentName: "codex-hostname-null",
    scopes,
    correlationId: "cid-test",
    issuer: "proxmox-gw",
    expiresAt: Math.floor(Date.now() / 1000) + 900,
  };
}

describe("packages/host/tests/scope-acl.test.ts — AJS-57 scope enforcement contract", () => {
  /**
   * WHAT: An identity whose `scopes` includes the required scope
   *       returns `{ ok: true }`.
   * WHY: Positive path. Every Provider tool defines its required
   *      scope at registration; this is the green-light branch where
   *      dispatch proceeds.
   */
  test("required scope present → ok", () => {
    const result = checkScope(
      identity(["matrix.send_message", "matrix.read"]),
      "matrix.send_message",
    );
    expect(result.ok).toBe(true);
  });

  /**
   * WHAT: An identity whose `scopes` does NOT include the required
   *       scope returns `{ ok: false, message }` where the message
   *       explicitly names the missing scope.
   * WHY: Security primary path. If we silently allow the call, a JWT
   *      whose `scopes` claim is wrong (or empty due to a verifier
   *      regression that defaulted scopes) would grant unauthorized
   *      access. The error message naming the scope helps operators
   *      diagnose misconfigured JWT mints quickly.
   */
  test("required scope absent → reject with explicit scope name in message", () => {
    const result = checkScope(identity(["matrix.read"]), "matrix.send_message");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("matrix.send_message");
  });

  /**
   * WHAT: An identity with `scopes: []` is rejected for any required
   *       scope.
   * WHY: Empty scopes is the verifier's signal that a JWT had no
   *      `scopes` claim. Allowing any tool through with empty scopes
   *      would silently grant capabilities. Pin the rejection.
   */
  test("identity with empty scopes → reject any required scope", () => {
    const result = checkScope(identity([]), "matrix.send_message");
    expect(result.ok).toBe(false);
  });

  /**
   * WHAT: Scope match is case-sensitive — `matrix.send_message` does
   *       NOT satisfy `Matrix.Send_Message`.
   * WHY: Per AJS-56 naming convention (resolved Q3): MCP tool names
   *      are snake_case lowercase. Accepting case variations would
   *      let a typo'd scope (`Matrix.send_message`) accidentally
   *      grant the unrelated lowercase capability. Strict-match is
   *      the safer default.
   */
  test("scope match is case-sensitive", () => {
    const result = checkScope(identity(["Matrix.Send_Message"]), "matrix.send_message");
    expect(result.ok).toBe(false);
  });

  /**
   * WHAT: An undefined / null identity argument is rejected.
   * WHY: Defense-in-depth. If a caller bug skips the verifier and
   *      passes a null identity to `checkScope`, the ACL must still
   *      reject (not throw, not allow). Crashing here would expose a
   *      "scope check threw, fell through to allow" anti-pattern; the
   *      stable contract is "no identity → no permission."
   */
  test("null / undefined identity → reject", () => {
    // biome-ignore lint/suspicious/noExplicitAny: defense-in-depth test for runtime null injection
    const nullResult = checkScope(null as any, "matrix.send_message");
    expect(nullResult.ok).toBe(false);
    // biome-ignore lint/suspicious/noExplicitAny: defense-in-depth test for runtime undefined injection
    const undefResult = checkScope(undefined as any, "matrix.send_message");
    expect(undefResult.ok).toBe(false);
  });
});
