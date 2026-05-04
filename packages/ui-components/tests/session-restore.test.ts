import { describe, expect, test } from "bun:test";
import { SESSION_RESTORE_FAILURE_MESSAGE } from "@agents-js/acp-host/session-restore";
import { shouldClearStaleSessionHash } from "../src/session-restore.ts";

describe("shouldClearStaleSessionHash", () => {
  test("clears the stale hash when restore fails before a replacement session exists", () => {
    expect(
      shouldClearStaleSessionHash(
        {
          lastError: SESSION_RESTORE_FAILURE_MESSAGE,
          sessionId: null,
        },
        "stale-session-1",
      ),
    ).toBe(true);
  });

  test("keeps the hash when no restore is pending or a replacement session exists", () => {
    expect(
      shouldClearStaleSessionHash(
        {
          lastError: SESSION_RESTORE_FAILURE_MESSAGE,
          sessionId: "fresh-session-2",
        },
        "stale-session-1",
      ),
    ).toBe(false);
    expect(
      shouldClearStaleSessionHash(
        {
          lastError: SESSION_RESTORE_FAILURE_MESSAGE,
          sessionId: null,
        },
        null,
      ),
    ).toBe(false);
  });
});
