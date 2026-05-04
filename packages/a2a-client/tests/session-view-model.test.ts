import { describe, expect, test } from "bun:test";
import { createInitialSessionState, describeSessionStatus } from "../src/index.ts";
import type { A2ASessionState } from "../src/types.ts";

function withState(overrides: Partial<A2ASessionState>): A2ASessionState {
  return {
    ...createInitialSessionState(),
    ...overrides,
  };
}

describe("describeSessionStatus", () => {
  test("idle/connected (no taskState) → info severity, ready label, no busy flag", () => {
    expect(describeSessionStatus(withState({ status: "idle" }))).toMatchObject({
      label: "Idle",
      severity: "info",
      busy: false,
      terminal: false,
      recoverable: false,
    });
    expect(describeSessionStatus(withState({ status: "connected" }))).toMatchObject({
      label: "Ready",
      severity: "info",
      busy: false,
      terminal: false,
      recoverable: false,
    });
  });

  test("completed taskState → terminal/info with concise label (not 'Task state: completed')", () => {
    const vm = describeSessionStatus(withState({ status: "connected", taskState: "completed" }));
    expect(vm.label).toBe("Completed");
    expect(vm.severity).toBe("info");
    expect(vm.terminal).toBe(true);
    expect(vm.busy).toBe(false);
    // Brief explicitly calls out "Task state: completed" as awkward — verify
    // the helper produces protocol-neutral copy.
    expect(vm.label).not.toContain("Task");
    expect(vm.label).not.toContain("state");
  });

  test("sending status → busy flag, cancel as primary action", () => {
    const vm = describeSessionStatus(withState({ status: "sending" }));
    expect(vm.busy).toBe(true);
    expect(vm.severity).toBe("busy");
    expect(vm.terminal).toBe(false);
    expect(vm.primaryAction).toEqual({ kind: "cancel", label: "Cancel" });
  });

  test("waiting status → busy with 'Working…' label and cancel action", () => {
    const vm = describeSessionStatus(withState({ status: "waiting" }));
    expect(vm.busy).toBe(true);
    expect(vm.severity).toBe("busy");
    expect(vm.label).toBe("Working…");
    expect(vm.primaryAction?.kind).toBe("cancel");
  });

  test("connecting status → busy with 'Connecting' label", () => {
    const vm = describeSessionStatus(withState({ status: "connecting" }));
    expect(vm.busy).toBe(true);
    expect(vm.severity).toBe("busy");
    expect(vm.label).toBe("Connecting");
  });

  test("input_required taskState → actionable severity + 'Provide input' primary action", () => {
    const vm = describeSessionStatus(
      withState({
        status: "connected", // Lower-resolution axis says connected — view-model
        // ignores it because taskState takes priority.
        taskState: "input-required",
        resumableTaskId: "task-1",
        activeElicitation: {
          mode: "form",
          message: "Pick a project",
          metadata: undefined,
          requestedSchema: {
            title: null,
            description: null,
            properties: undefined,
            required: undefined,
          },
          sessionId: "sess-1",
        },
      }),
    );
    expect(vm.severity).toBe("actionable");
    expect(vm.recoverable).toBe(true);
    expect(vm.terminal).toBe(false);
    expect(vm.busy).toBe(false);
    expect(vm.primaryAction).toEqual({ kind: "respond_input", label: "Provide input" });
    expect(vm.secondaryAction).toEqual({ kind: "cancel", label: "Cancel" });
    expect(vm.helperText).toBe("Pick a project");
  });

  test("auth_required taskState → actionable severity + 'Authenticate' primary action", () => {
    const vm = describeSessionStatus(
      withState({
        status: "connected",
        taskState: "auth-required",
        resumableTaskId: "task-1",
        activeAuth: {
          message: "Sign in to continue",
          authMethods: [{ id: "oauth", name: "OAuth" }],
        },
      }),
    );
    expect(vm.severity).toBe("actionable");
    expect(vm.recoverable).toBe(true);
    expect(vm.terminal).toBe(false);
    expect(vm.primaryAction).toEqual({ kind: "respond_auth", label: "Authenticate" });
    expect(vm.helperText).toBe("Sign in to continue");
  });

  test("failed taskState → error severity, terminal, retry as primary action", () => {
    const vm = describeSessionStatus(withState({ status: "connected", taskState: "failed" }));
    expect(vm.severity).toBe("error");
    expect(vm.terminal).toBe(true);
    expect(vm.recoverable).toBe(true);
    expect(vm.primaryAction).toEqual({ kind: "retry", label: "Retry" });
  });

  test("auth_required is distinguishable from generic error severity", () => {
    // Brief: "Auth-required should not be collapsed into a generic error
    // unless the task is actually failed."
    const authVm = describeSessionStatus(
      withState({ status: "auth_required", taskState: "auth-required" }),
    );
    const errVm = describeSessionStatus(withState({ taskState: "failed" }));

    expect(authVm.severity).toBe("actionable");
    expect(errVm.severity).toBe("error");
    expect(authVm.terminal).toBe(false);
    expect(errVm.terminal).toBe(true);
    expect(authVm.primaryAction?.kind).toBe("respond_auth");
    expect(errVm.primaryAction?.kind).toBe("retry");
  });

  test("lastError set → error severity with retry/reset actions", () => {
    const vm = describeSessionStatus(
      withState({ status: "error", lastError: "transport refused" }),
    );
    expect(vm.severity).toBe("error");
    expect(vm.helperText).toBe("transport refused");
    expect(vm.primaryAction?.kind).toBe("retry");
    expect(vm.secondaryAction?.kind).toBe("reset");
  });

  test("taskState takes priority over status (the view-model bug this test covers)", () => {
    // Streaming input-required leaves status === "connected" but
    // taskState === "input-required". The view-model MUST surface the
    // protocol-level state, not the lower-resolution status.
    const vm = describeSessionStatus(
      withState({
        status: "connected",
        taskState: "input-required",
        resumableTaskId: "task-1",
      }),
    );
    expect(vm.label).toBe("Awaiting input");
    expect(vm.severity).toBe("actionable");
  });

  test("canceled taskState → terminal/info with retry option", () => {
    const vm = describeSessionStatus(withState({ taskState: "canceled" }));
    expect(vm.label).toBe("Canceled");
    expect(vm.severity).toBe("info");
    expect(vm.terminal).toBe(true);
    expect(vm.primaryAction?.kind).toBe("retry");
  });

  test("rejected taskState → terminal/error, not recoverable", () => {
    const vm = describeSessionStatus(withState({ taskState: "rejected" }));
    expect(vm.severity).toBe("error");
    expect(vm.terminal).toBe(true);
    expect(vm.recoverable).toBe(false);
    expect(vm.primaryAction).toBeUndefined();
  });

  test("helper is pure (same input → same output, no shared state)", () => {
    const state = withState({ taskState: "input-required" });
    const vm1 = describeSessionStatus(state);
    const vm2 = describeSessionStatus(state);
    expect(vm1).toEqual(vm2);
    // Different state instances with the same shape produce equal view-models.
    expect(describeSessionStatus(withState({ taskState: "input-required" }))).toEqual(vm1);
  });

  test("labels are protocol-neutral (no 'task', 'state', 'kind' jargon)", () => {
    const cases: Array<Partial<A2ASessionState>> = [
      { status: "idle" },
      { status: "connected" },
      { status: "connecting" },
      { status: "sending" },
      { status: "waiting" },
      { status: "completed" },
      { status: "error", lastError: "x" },
      { taskState: "completed" },
      { taskState: "failed" },
      { taskState: "canceled" },
      { taskState: "rejected" },
      { taskState: "input-required", resumableTaskId: "t" },
      { taskState: "auth-required", resumableTaskId: "t" },
    ];

    for (const overrides of cases) {
      const label = describeSessionStatus(withState(overrides)).label.toLowerCase();
      expect(label).not.toMatch(/\btask\b/);
      expect(label).not.toMatch(/\bstate\b/);
      expect(label).not.toMatch(/\bkind\b/);
    }
  });
});
