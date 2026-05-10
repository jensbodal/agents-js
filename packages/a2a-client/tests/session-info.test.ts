/**
 * Layer 2 — `session.info.updated` reducer unit tests.
 *
 * Asserts the three-state semantic for `title` / `updatedAt` per ACP
 * `SessionInfoUpdate`:
 *   - field omitted (or set to `undefined`) → preserve prior state
 *   - field present and `null`               → store `null` (explicit clear)
 *   - field present as a string              → replace
 *
 * The TUI needs to distinguish "agent withdrew the title" (`null`
 * stored on state) from "agent never had one" (state field is
 * `undefined` / never set). Both omitted-property and explicit
 * `undefined` map to the same "no change" semantic — the reducer
 * uses `!== undefined` rather than `in` membership so partially
 * constructed events with `{ title: undefined }` don't accidentally
 * overwrite state.
 */
import { describe, expect, test } from "bun:test";
import { createInitialSessionState, reduceA2ASessionState } from "../src/session.ts";

describe("session.info.updated reducer", () => {
  test("sets title and updatedAt from string values", () => {
    const initial = createInitialSessionState({ sessionId: "s1" });
    const next = reduceA2ASessionState(initial, {
      type: "session.info.updated",
      title: "Refactor auth flow",
      updatedAt: "2026-05-09T20:00:00Z",
    });
    expect(next.sessionTitle).toBe("Refactor auth flow");
    expect(next.sessionUpdatedAt).toBe("2026-05-09T20:00:00Z");
  });

  test("preserves prior values when fields are absent on the event", () => {
    const initial = {
      ...createInitialSessionState({ sessionId: "s1" }),
      sessionTitle: "Existing title",
      sessionUpdatedAt: "2026-05-09T20:00:00Z",
    };
    const next = reduceA2ASessionState(initial, {
      type: "session.info.updated",
    });
    expect(next.sessionTitle).toBe("Existing title");
    expect(next.sessionUpdatedAt).toBe("2026-05-09T20:00:00Z");
  });

  test("stores null as explicit clear (distinct from absent)", () => {
    const initial = {
      ...createInitialSessionState({ sessionId: "s1" }),
      sessionTitle: "Existing title",
      sessionUpdatedAt: "2026-05-09T20:00:00Z",
    };
    const next = reduceA2ASessionState(initial, {
      type: "session.info.updated",
      title: null,
      updatedAt: null,
    });
    expect(next.sessionTitle).toBeNull();
    expect(next.sessionUpdatedAt).toBeNull();
  });

  test("partial update — only title set, updatedAt preserved", () => {
    const initial = {
      ...createInitialSessionState({ sessionId: "s1" }),
      sessionTitle: "old",
      sessionUpdatedAt: "2026-05-09T19:00:00Z",
    };
    const next = reduceA2ASessionState(initial, {
      type: "session.info.updated",
      title: "new",
    });
    expect(next.sessionTitle).toBe("new");
    expect(next.sessionUpdatedAt).toBe("2026-05-09T19:00:00Z");
  });

  test("explicit undefined on a field is treated as omitted (preserves prior)", () => {
    // Locks in the `!== undefined` semantic rather than `in`-membership.
    // A caller constructing `{ title: undefined }` via spread / partial
    // merge MUST NOT wipe state — that contradicts the ACP spec
    // ("undefined = no change") and would surprise downstream code.
    const initial = {
      ...createInitialSessionState({ sessionId: "s1" }),
      sessionTitle: "preserved",
      sessionUpdatedAt: "2026-05-09T19:00:00Z",
    };
    const next = reduceA2ASessionState(initial, {
      type: "session.info.updated",
      title: undefined,
      updatedAt: undefined,
    });
    expect(next.sessionTitle).toBe("preserved");
    expect(next.sessionUpdatedAt).toBe("2026-05-09T19:00:00Z");
  });

  test("partial null clear — title cleared, updatedAt preserved", () => {
    const initial = {
      ...createInitialSessionState({ sessionId: "s1" }),
      sessionTitle: "old",
      sessionUpdatedAt: "2026-05-09T19:00:00Z",
    };
    const next = reduceA2ASessionState(initial, {
      type: "session.info.updated",
      title: null,
    });
    expect(next.sessionTitle).toBeNull();
    expect(next.sessionUpdatedAt).toBe("2026-05-09T19:00:00Z");
  });
});
