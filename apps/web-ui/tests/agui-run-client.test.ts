import { describe, expect, test } from "bun:test";
import {
  AguiRunBusyError,
  runTurnViaAgUi,
  wrapControllerForAgUiRuns,
} from "../src/agui-run-client.ts";

/**
 * The AG-UI run client is the bridge from chat-app's `sendTurn` to the
 * gateway's `POST /agent` endpoint. Unit-test the contract without
 * standing up a real gateway:
 *
 *   - 409 Busy → typed AguiRunBusyError
 *   - RUN_FINISHED resolves the promise
 *   - RUN_ERROR rejects with the server-supplied message
 *   - wrapControllerForAgUiRuns mutates sendTurn in place and keeps
 *     legacy A2A sendTurn accessible
 */
describe("runTurnViaAgUi", () => {
  function makeSseResponse(frames: object[]): Response {
    const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  test("resolves when RUN_FINISHED arrives in the SSE stream", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      makeSseResponse([
        { type: "RUN_STARTED", threadId: "t-1", runId: "r-1" },
        { type: "RUN_FINISHED", threadId: "t-1", runId: "r-1" },
      ]);
    try {
      await runTurnViaAgUi({
        baseUrl: "http://gateway.local",
        text: "hi",
        threadId: "t-1",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws AguiRunBusyError on HTTP 409", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: "Busy",
          message: "another AG-UI run is active",
          activeRunId: "active-run-99",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    try {
      await expect(
        runTurnViaAgUi({
          baseUrl: "http://gateway.local",
          text: "hi",
          threadId: "t-1",
        }),
      ).rejects.toBeInstanceOf(AguiRunBusyError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects with the RUN_ERROR message", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      makeSseResponse([
        { type: "RUN_STARTED", threadId: "t-1", runId: "r-1" },
        { type: "RUN_ERROR", message: "controller exploded" },
      ]);
    try {
      await expect(
        runTurnViaAgUi({
          baseUrl: "http://gateway.local",
          text: "hi",
          threadId: "t-1",
        }),
      ).rejects.toThrow("controller exploded");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects on non-2xx non-409 HTTP status", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("internal", { status: 500 });
    try {
      await expect(
        runTurnViaAgUi({
          baseUrl: "http://gateway.local",
          text: "hi",
          threadId: "t-1",
        }),
      ).rejects.toThrow(/HTTP 500/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("wrapControllerForAgUiRuns", () => {
  test("mutates sendTurn in place and keeps legacyA2ASendTurn accessible", () => {
    let legacyCalls = 0;
    const controller = {
      getState() {
        return { targetInput: { url: "http://gateway.local" } };
      },
      sendTurn: async (_text: string) => {
        legacyCalls += 1;
        return { kind: "a2a" } as unknown;
      },
    };

    const wrapped = wrapControllerForAgUiRuns(controller, { fallbackBaseUrl: "" });

    // The wrapped reference is the same instance — chatApp.controller
    // pointing at the original baseController must keep working.
    expect(wrapped).toBe(controller);
    expect(typeof wrapped.legacyA2ASendTurn).toBe("function");

    // Invoking legacyA2ASendTurn must hit the original behavior.
    void wrapped.legacyA2ASendTurn("hello");
    expect(legacyCalls).toBe(1);
  });

  test("falls back to legacy sendTurn when getState returns no target URL and no fallback is configured", async () => {
    let legacyCalls = 0;
    const controller = {
      getState() {
        return { targetInput: null };
      },
      sendTurn: async (_text: string) => {
        legacyCalls += 1;
        return { kind: "a2a" } as unknown;
      },
    };

    wrapControllerForAgUiRuns(controller, { fallbackBaseUrl: "" });
    await controller.sendTurn("hi");
    expect(legacyCalls).toBe(1);
  });
});
