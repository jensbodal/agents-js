/**
 * `KNOWN_DISPATCH_FAILURE_KINDS` + `isKnownDispatchFailureKind` +
 * `DispatchFailureReason` shape — invariants for the typed dispatch-failure
 * union (AJS-79 PR3a).
 *
 * **Scope (Path 2 amend, cid `cognee-claude-pr68-path2-1444z`):** PR3a
 * defines the typed union in `@agents-js/policy` as single source of
 * truth and consumes it at internal permission-gate sites
 * (`session-permissions.ts`, via `satisfies DispatchFailureReason`).
 * The wire payload in `@agents-js/host`
 * (`MatrixBusReplyPayload.failureReason`) intentionally still emits the
 * legacy kebab-case string union; the wire-shape flip from string-enum
 * to typed object is AJS-79 PR3b scope and requires a co-landing
 * dot-matrix bridge PR (router parses both shapes) to avoid silently
 * breaking DOT-393 fallback at the federation boundary (caught by
 * cognee-codex source-check).
 *
 * Mirrors the `KNOWN_OPERATION_CLASSES` discipline: one assertion per kind
 * + a `Record<DispatchFailureKind, true>`-derived set so adding a kind to
 * the union without extending the record fails typecheck at the record
 * declaration before this test even runs.
 */

import { describe, expect, test } from "bun:test";
import {
  type DispatchFailureKind,
  type DispatchFailureReason,
  isKnownDispatchFailureKind,
  KNOWN_DISPATCH_FAILURE_KINDS,
} from "../src/permission-types.ts";

describe("KNOWN_DISPATCH_FAILURE_KINDS", () => {
  // Permission-policy kinds (from session-permissions.ts auto-approve gate).
  test("contains unknown_operation_class", () => {
    expect(KNOWN_DISPATCH_FAILURE_KINDS.has("unknown_operation_class")).toBe(true);
  });

  test("contains no_workspace_identity_path", () => {
    expect(KNOWN_DISPATCH_FAILURE_KINDS.has("no_workspace_identity_path")).toBe(true);
  });

  test("contains workspace_boundary_violation", () => {
    expect(KNOWN_DISPATCH_FAILURE_KINDS.has("workspace_boundary_violation")).toBe(true);
  });

  test("contains no_allow_option", () => {
    expect(KNOWN_DISPATCH_FAILURE_KINDS.has("no_allow_option")).toBe(true);
  });

  // Dispatch-transport kinds (from matrix-bus-consumer + internal-gateway).
  test("contains dispatch_error", () => {
    expect(KNOWN_DISPATCH_FAILURE_KINDS.has("dispatch_error")).toBe(true);
  });

  test("contains dispatch_timeout", () => {
    expect(KNOWN_DISPATCH_FAILURE_KINDS.has("dispatch_timeout")).toBe(true);
  });

  test("contains consumer_unreachable", () => {
    expect(KNOWN_DISPATCH_FAILURE_KINDS.has("consumer_unreachable")).toBe(true);
  });

  test("does NOT contain the kebab-case wire values (vocabulary separation)", () => {
    // The current wire shape is a string enum with kebab-case values
    // (`"dispatch-error"`, `"consumer-unreachable"`, `"dispatch-timeout"`)
    // and stays that way through PR3a (Path 2 amend). The typed union
    // intentionally uses snake_case for the FUTURE wire vocabulary that
    // PR3b will ship alongside the dot-matrix bridge dual-parse companion.
    // This regression guard catches accidental drift between the two
    // vocabularies — if PR3b lands without the bridge companion the
    // snake_case kinds would silently bypass DOT-393 fallback.
    expect(KNOWN_DISPATCH_FAILURE_KINDS.has("dispatch-error" as DispatchFailureKind)).toBe(false);
    expect(KNOWN_DISPATCH_FAILURE_KINDS.has("consumer-unreachable" as DispatchFailureKind)).toBe(
      false,
    );
    expect(KNOWN_DISPATCH_FAILURE_KINDS.has("dispatch-timeout" as DispatchFailureKind)).toBe(false);
  });
});

describe("isKnownDispatchFailureKind", () => {
  test("narrows known kinds (true)", () => {
    expect(isKnownDispatchFailureKind("dispatch_error")).toBe(true);
    expect(isKnownDispatchFailureKind("workspace_boundary_violation")).toBe(true);
  });

  test("rejects kebab-case wire values (false — vocabulary separation)", () => {
    // Wire-shape strings (kebab-case) are intentionally not members of the
    // typed snake_case union. See header comment for the Path 2 / PR3b
    // wire-flip plan.
    expect(isKnownDispatchFailureKind("dispatch-error")).toBe(false);
    expect(isKnownDispatchFailureKind("consumer-unreachable")).toBe(false);
  });

  test("rejects arbitrary strings (false)", () => {
    expect(isKnownDispatchFailureKind("")).toBe(false);
    expect(isKnownDispatchFailureKind("not-a-kind")).toBe(false);
  });
});

describe("DispatchFailureReason discriminated union shape", () => {
  // Compile-time shape assertions: each variant carries the right fields.
  // Runtime expectations follow once `satisfies` constrains the literal.
  test("permission kinds carry operationClass", () => {
    const reasons: DispatchFailureReason[] = [
      { kind: "unknown_operation_class", operationClass: "tool.unknown" },
      { kind: "no_workspace_identity_path", operationClass: "workspace.shell.read" },
      { kind: "workspace_boundary_violation", operationClass: "workspace.shell.read" },
      { kind: "no_allow_option", operationClass: "file.write" },
    ];
    for (const r of reasons) {
      expect("operationClass" in r).toBe(true);
    }
  });

  test("transport kinds may carry an optional message", () => {
    const withMessage: DispatchFailureReason = {
      kind: "dispatch_error",
      message: "TypeError: foo",
    };
    const withoutMessage: DispatchFailureReason = { kind: "consumer_unreachable" };
    expect(withMessage.message).toContain("TypeError");
    expect("message" in withoutMessage).toBe(false);
  });

  test("transport kinds do NOT carry operationClass", () => {
    const reason: DispatchFailureReason = { kind: "dispatch_timeout" };
    expect("operationClass" in reason).toBe(false);
  });
});
