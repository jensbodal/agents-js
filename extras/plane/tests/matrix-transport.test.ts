import { describe, expect, test } from "bun:test";
import createMatrixNotifierFromEnv from "../src/transport/matrix.ts";

describe("Matrix transport", () => {
  test("createMatrixNotifierFromEnv does not notify when notification env is unset", async () => {
    const logs: unknown[] = [];
    const notifier = createMatrixNotifierFromEnv(
      {
        log: (...args) => logs.push(args),
        warn: (...args) => logs.push(args),
        error: (...args) => logs.push(args),
      },
      {
        PLANE_WEBHOOK_MATRIX_CLIENT: "/opt/matrix-client.ts",
        PLANE_WEBHOOK_MATRIX_AGENT: "ops-bot",
        PLANE_WEBHOOK_MATRIX_ROOM: "alerts",
      },
    );

    const sent = await notifier("test message");

    expect(sent).toBe(false);
    expect(JSON.stringify(logs)).toContain("notification disabled by env");
  });

  test("createMatrixNotifierFromEnv sends the expected argv when enabled", async () => {
    const calls: Array<{
      args: string[];
      command: string;
      options: { onError?: "throw" | "return"; timeoutMs?: number };
    }> = [];
    const notifier = createMatrixNotifierFromEnv(
      {
        log: () => {},
        warn: () => {},
        error: () => {},
      },
      {
        PLANE_WEBHOOK_NOTIFY_ENABLED: "1",
        PLANE_WEBHOOK_BUN: "/opt/bun",
        PLANE_WEBHOOK_MATRIX_CLIENT: "/opt/matrix-client.ts",
        PLANE_WEBHOOK_MATRIX_AGENT: "ops-bot",
        PLANE_WEBHOOK_MATRIX_ROOM: "alerts",
      },
      {
        runCommand: async (command, args, options) => {
          calls.push({
            command,
            args: [...args],
            options: {
              onError: options?.onError,
              timeoutMs: options?.timeoutMs,
            },
          });
          return { aborted: false, exitCode: 0, stderr: "", stdout: "", timedOut: false };
        },
      },
    );

    expect(await notifier("Plane issue Done: DOT-301 Example")).toBe(true);
    expect(calls).toEqual([
      {
        command: "/opt/bun",
        args: [
          "/opt/matrix-client.ts",
          "send",
          "--as",
          "ops-bot",
          "--room",
          "alerts",
          "--plain",
          "Plane issue Done: DOT-301 Example",
        ],
        options: { onError: "throw", timeoutMs: 10_000 },
      },
    ]);
  });

  test("createMatrixNotifierFromEnv throws at construction when enabled but required env is missing", () => {
    expect(() =>
      createMatrixNotifierFromEnv(
        {
          log: () => {},
          warn: () => {},
          error: () => {},
        },
        {
          PLANE_WEBHOOK_NOTIFY_ENABLED: "1",
          PLANE_WEBHOOK_MATRIX_CLIENT: "/opt/matrix-client.ts",
          // MATRIX_AGENT and MATRIX_ROOM intentionally missing
        },
      ),
    ).toThrow(/PLANE_WEBHOOK_MATRIX_AGENT.*PLANE_WEBHOOK_MATRIX_ROOM/);
  });
});
