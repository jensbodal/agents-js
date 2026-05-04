import { describe, expect, test } from "bun:test";
import type { ExecutionEventBus } from "@agents-js/a2a";
import type { ACPSessionController, ACPSessionEvent, ACPSessionState } from "@agents-js/acp-host";
import { subscribeDispatchController } from "../src/host-executor.ts";

/**
 * @@dispatch is non-interactive — it has no UI to prompt the operator
 * for permission/write-gate/elicitation responses. Under inherited
 * permission modes ("ask", "plan", "hub") an agent that emits one of
 * these events would otherwise hang the dispatch indefinitely
 * waiting for a `resolvePermission` call that nobody will make.
 *
 * The contract enforced by `subscribeDispatchController`:
 *   1. Publish a *failed* status update with a clear, action-shaped
 *      message so A2A clients know what happened.
 *   2. Call `controller.cancel()` so the in-flight `sendPrompt`
 *      unblocks and the dispatch's outer try/finally can publish a
 *      terminal task.
 *
 * These tests exercise the subscription handler directly with a
 * stubbed controller — much cheaper than spinning up a real ACP
 * process that emits permission events (the mock-acp-agent does not
 * support them).
 */

interface StubController {
  controller: Pick<ACPSessionController, "subscribe" | "cancel">;
  emit(event: ACPSessionEvent): void;
  cancelCalls: () => number;
}

function createStubController(): StubController {
  let cancelCount = 0;
  type Listener = (event: ACPSessionEvent, state: ACPSessionState) => void;
  const listeners = new Set<Listener>();

  return {
    controller: {
      subscribe(listener) {
        listeners.add(listener as Listener);
        return () => {
          listeners.delete(listener as Listener);
        };
      },
      async cancel() {
        cancelCount += 1;
      },
    },
    emit(event) {
      for (const listener of listeners) {
        listener(event, {} as ACPSessionState);
      }
    },
    cancelCalls: () => cancelCount,
  };
}

function createEventBus(): {
  eventBus: ExecutionEventBus;
  published: unknown[];
} {
  const published: unknown[] = [];
  const eventBus: ExecutionEventBus = {
    publish(event: unknown) {
      published.push(event);
    },
    finished() {},
    on() {},
    off() {},
    once() {},
    removeAllListeners() {},
  } as unknown as ExecutionEventBus;
  return { eventBus, published };
}

describe("subscribeDispatchController — non-interactive contract", () => {
  test("permission_requested → publishes failed status AND cancels controller", async () => {
    const stub = createStubController();
    const { eventBus, published } = createEventBus();

    subscribeDispatchController(stub.controller as ACPSessionController, {
      taskId: "task-1",
      contextId: "ctx-1",
      eventBus,
    });

    stub.emit({
      type: "permission_requested",
      request: {
        sessionId: "s-1",
        toolCall: { toolCallId: "tc-1", title: "Read file", rawInput: { path: "/etc/passwd" } },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
      },
    } as ACPSessionEvent);

    // Allow the fire-and-forget cancel microtask to run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const failed = published.find(
      (e) =>
        (e as { kind?: string; status?: { state?: string } }).kind === "status-update" &&
        (e as { status: { state: string } }).status.state === "failed",
    ) as { status: { message?: { parts: { kind: string; text?: string }[] } } } | undefined;
    expect(failed).toBeDefined();
    const text = failed?.status.message?.parts.find((p) => p.kind === "text")?.text;
    expect(text).toContain("non-interactive");
    expect(text).toContain("Read file");
    expect(stub.cancelCalls()).toBe(1);
  });

  test("write_gate_requested → failed status AND cancel", async () => {
    const stub = createStubController();
    const { eventBus, published } = createEventBus();

    subscribeDispatchController(stub.controller as ACPSessionController, {
      taskId: "task-2",
      contextId: "ctx-2",
      eventBus,
    });

    stub.emit({
      type: "write_gate_requested",
      path: "drafts/notes.md",
      closestParentFolder: "drafts",
    } as ACPSessionEvent);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const failed = published.find(
      (e) =>
        (e as { kind?: string; status?: { state?: string } }).kind === "status-update" &&
        (e as { status: { state: string } }).status.state === "failed",
    ) as { status: { message?: { parts: { kind: string; text?: string }[] } } } | undefined;
    expect(failed).toBeDefined();
    const text = failed?.status.message?.parts.find((p) => p.kind === "text")?.text;
    expect(text).toContain("non-interactive");
    expect(text).toContain("drafts/notes.md");
    expect(stub.cancelCalls()).toBe(1);
  });

  test("elicitation_requested → failed status AND cancel", async () => {
    const stub = createStubController();
    const { eventBus, published } = createEventBus();

    subscribeDispatchController(stub.controller as ACPSessionController, {
      taskId: "task-3",
      contextId: "ctx-3",
      eventBus,
    });

    stub.emit({
      type: "elicitation_requested",
      request: {
        sessionId: "s-1",
        elicitationId: "el-1",
        message: "Confirm action?",
        url: "about:blank",
        mode: "url",
      },
    } as ACPSessionEvent);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const failed = published.find(
      (e) =>
        (e as { kind?: string; status?: { state?: string } }).kind === "status-update" &&
        (e as { status: { state: string } }).status.state === "failed",
    );
    expect(failed).toBeDefined();
    expect(stub.cancelCalls()).toBe(1);
  });

  test("normal session_update text chunk does NOT cancel the controller", async () => {
    const stub = createStubController();
    const { eventBus, published } = createEventBus();

    subscribeDispatchController(stub.controller as ACPSessionController, {
      taskId: "task-4",
      contextId: "ctx-4",
      eventBus,
    });

    stub.emit({
      type: "session_update",
      notification: {
        sessionId: "s-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello!" },
          messageId: "msg-1",
        },
      },
    } as ACPSessionEvent);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stub.cancelCalls()).toBe(0);
    expect(published.length).toBeGreaterThan(0);
  });

  test("hasNonInteractiveFailure flips after a permission event (race guard)", async () => {
    // Even with cancel-on-event, sendPrompt can resolve after the
    // cancel is issued — and dispatchAcp would publish a
    // "completed" terminal on top of the subscription's already-
    // final "failed" status update. The race guard relies on this
    // getter; the test pins the contract so future changes cannot
    // drop the flag.
    const stub = createStubController();
    const { eventBus } = createEventBus();

    const subscription = subscribeDispatchController(stub.controller as ACPSessionController, {
      taskId: "task-race",
      contextId: "ctx-race",
      eventBus,
    });
    expect(subscription.hasNonInteractiveFailure()).toBe(false);

    stub.emit({
      type: "permission_requested",
      request: {
        sessionId: "s-race",
        toolCall: { toolCallId: "tc-1", title: "Run", rawInput: {} },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
      },
    } as ACPSessionEvent);

    expect(subscription.hasNonInteractiveFailure()).toBe(true);
  });

  test("error event does NOT itself cancel — outer dispatch path handles termination", async () => {
    // The error case publishes a failed status but does not call cancel
    // because the controller is already in an error state; calling cancel
    // would just be redundant noise.
    const stub = createStubController();
    const { eventBus, published } = createEventBus();

    subscribeDispatchController(stub.controller as ACPSessionController, {
      taskId: "task-5",
      contextId: "ctx-5",
      eventBus,
    });

    stub.emit({
      type: "error",
      message: "agent died",
    } as ACPSessionEvent);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stub.cancelCalls()).toBe(0);
    const failed = published.find(
      (e) =>
        (e as { kind?: string; status?: { state?: string } }).kind === "status-update" &&
        (e as { status: { state: string } }).status.state === "failed",
    );
    expect(failed).toBeDefined();
  });
});
