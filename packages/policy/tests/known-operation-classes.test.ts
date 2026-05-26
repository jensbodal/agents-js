/**
 * `KNOWN_OPERATION_CLASSES` + `isKnownOperationClass` + `assertNever` —
 * shape guarantees for the typed-plumbing PR that adds the
 * `unattendedGateway` permission mode. The exhaustive auto-approve switch in
 * `session-permissions.ts` relies on this set being the single source of truth
 * for the `OperationClass` union.
 */

import { describe, expect, test } from "bun:test";
import {
  assertNever,
  isKnownOperationClass,
  KNOWN_OPERATION_CLASSES,
  type OperationClass,
} from "../src/permission-types.ts";

describe("KNOWN_OPERATION_CLASSES", () => {
  // One assertion per class; if any of these are removed from the union the
  // expectation here breaks loudly. Conversely, if a new class is added to
  // the union without extending the record in `permission-types.ts`, the
  // typecheck breaks at the record declaration before this test even runs.
  test("contains file.read", () => {
    expect(KNOWN_OPERATION_CLASSES.has("file.read")).toBe(true);
  });

  test("contains file.write", () => {
    expect(KNOWN_OPERATION_CLASSES.has("file.write")).toBe(true);
  });

  test("contains file.delete", () => {
    expect(KNOWN_OPERATION_CLASSES.has("file.delete")).toBe(true);
  });

  test("contains terminal.create", () => {
    expect(KNOWN_OPERATION_CLASSES.has("terminal.create")).toBe(true);
  });

  test("contains workspace.search", () => {
    expect(KNOWN_OPERATION_CLASSES.has("workspace.search")).toBe(true);
  });

  test("contains workspace.command.execute", () => {
    expect(KNOWN_OPERATION_CLASSES.has("workspace.command.execute")).toBe(true);
  });

  test("contains workspace.command.list", () => {
    expect(KNOWN_OPERATION_CLASSES.has("workspace.command.list")).toBe(true);
  });

  test("contains workspace.data-query", () => {
    expect(KNOWN_OPERATION_CLASSES.has("workspace.data-query")).toBe(true);
  });

  test("contains workspace.navigate", () => {
    expect(KNOWN_OPERATION_CLASSES.has("workspace.navigate")).toBe(true);
  });

  test("contains workspace.shell.read", () => {
    expect(KNOWN_OPERATION_CLASSES.has("workspace.shell.read")).toBe(true);
  });

  test("contains workspace.shell.search", () => {
    expect(KNOWN_OPERATION_CLASSES.has("workspace.shell.search")).toBe(true);
  });

  test("contains workspace.shell.list", () => {
    expect(KNOWN_OPERATION_CLASSES.has("workspace.shell.list")).toBe(true);
  });

  test("does NOT contain the open-ended `tool.<name>` fallback", () => {
    // The classifier emits `tool.<name>` for unrecognised tool titles; that
    // bucket must never narrow to `OperationClass` because the fail-closed
    // gate for unattended-gateway depends on excluding it.
    expect(KNOWN_OPERATION_CLASSES.has("tool.custom" as OperationClass)).toBe(false);
  });
});

describe("isKnownOperationClass", () => {
  test("narrows known classes to OperationClass (true)", () => {
    expect(isKnownOperationClass("file.read")).toBe(true);
    expect(isKnownOperationClass("workspace.shell.read")).toBe(true);
  });

  test("rejects the `tool.<name>` fallback bucket (false)", () => {
    expect(isKnownOperationClass("tool.unknown")).toBe(false);
    expect(isKnownOperationClass("tool.custom-probe")).toBe(false);
  });

  test("rejects empty string (false)", () => {
    expect(isKnownOperationClass("")).toBe(false);
  });

  test("rejects arbitrary nonsense (false)", () => {
    expect(isKnownOperationClass("not-a-class")).toBe(false);
  });
});

describe("assertNever", () => {
  test("throws with the expected message format", () => {
    // Cast through `unknown` because by definition no concrete value can be
    // typed as `never`; this simulates a runtime escape (e.g. a `as unknown
    // as never` in calling code) that bypassed the exhaustive-switch
    // typecheck.
    expect(() => assertNever("unexpected-value" as unknown as never)).toThrow(
      /Unhandled discriminant: "unexpected-value"/,
    );
  });

  test("includes a structured payload via JSON.stringify", () => {
    expect(() => assertNever({ kind: "shape" } as unknown as never)).toThrow(
      /Unhandled discriminant: \{"kind":"shape"\}/,
    );
  });
});
