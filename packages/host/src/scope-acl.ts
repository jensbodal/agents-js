/**
 * AJS-57 scope ACL — per-tool capability check.
 *
 * Companion to {@link verifyJwt}. The verifier resolves WHO is calling;
 * this module enforces WHAT they're allowed to call. Separating the
 * two concerns lets the dispatcher map verifier failures to 401 and
 * scope failures to 403 without conflating semantics.
 *
 * The check is intentionally trivial — `scopes.includes(required)`,
 * strict case-match. Sophisticated patterns (wildcard scopes,
 * scope hierarchies, scope inheritance) are out of v1 scope; design
 * doc resolution Q3 pins the 1:1 scope-to-tool mapping with explicit
 * scope names per call. Add complexity only when there's a real
 * caller need.
 */

import type { AuthenticatedIdentity } from "./jwt-verifier.ts";

/** Result of {@link checkScope}. Discriminated to mirror the verifier shape. */
export type ScopeCheckResult =
  | { ok: true }
  | { ok: false; reason: "scope-not-granted" | "no-identity"; message: string };

/**
 * Reject the call unless `identity.scopes` includes `requiredScope`
 * (strict, case-sensitive match).
 *
 * Returns `{ ok: false }` on:
 *  - null/undefined identity (defense-in-depth; never throws)
 *  - missing scope
 *
 * Returns `{ ok: true }` on:
 *  - exact case-sensitive match in `identity.scopes`
 */
export function checkScope(
  identity: AuthenticatedIdentity | null | undefined,
  requiredScope: string,
): ScopeCheckResult {
  if (!identity) {
    return {
      ok: false,
      reason: "no-identity",
      message: `scope ${requiredScope} check failed: no authenticated identity`,
    };
  }
  if (!identity.scopes.includes(requiredScope)) {
    return {
      ok: false,
      reason: "scope-not-granted",
      message: `scope ${requiredScope} not granted to ${identity.agentName}`,
    };
  }
  return { ok: true };
}
