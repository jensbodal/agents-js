/**
 * Learning tests for `agents-js client --agent <name> [--wait]`.
 *
 * LT-6: resolve a registered agent's url by NAME (kind a2a, non-empty url);
 *       a miss is a typed hard error; explicit --url/--card still win.
 * LT-7: --wait succeeds only once the entry is present AND health is 2xx,
 *       polling past absent/non-200, and stops immediately on success.
 * LT-8: --wait times out with a typed error and never connects.
 */
import { describe, expect, test } from "bun:test";
import type { AgentRegistryRecord } from "@agents-js/a2a-client/node";
import {
  AgentNotRegisteredError,
  ReadinessTimeoutError,
  resolveAgentUrl,
  waitForAgentReady,
} from "../src/client/agent-resolve.ts";
import { runClientCommand, type StartClientAppOptions } from "../src/client/command.ts";

const rec = (over: Partial<AgentRegistryRecord> & { name: string }): AgentRegistryRecord => ({
  agent_id: `host.${over.name}`,
  kind: "a2a",
  gateway_id: "host",
  source: "auto-reg",
  registered_at: "2026-06-09T00:00:00Z",
  ...over,
});

// LT-6 ----------------------------------------------------------------------
describe("resolveAgentUrl — LT-6", () => {
  test("returns the url of the matching a2a record by name", () => {
    const records = [
      rec({ name: "other", url: "http://10.0.0.1:1" }),
      rec({ name: "pi-a", url: "http://10.0.0.219:49622" }),
    ];
    expect(resolveAgentUrl(records, "pi-a")).toBe("http://10.0.0.219:49622");
  });

  test("throws AgentNotRegisteredError when no a2a record with a url matches", () => {
    const records = [
      rec({ name: "pi-a", kind: "acp", url: "http://x" }), // wrong kind (not a2a)
      rec({ name: "pi-b", url: "" }), // empty url
    ];
    expect(() => resolveAgentUrl(records, "pi-a")).toThrow(AgentNotRegisteredError);
    expect(() => resolveAgentUrl(records, "pi-b")).toThrow(/no registered A2A agent named "pi-b"/);
  });
});

// LT-7 ----------------------------------------------------------------------
describe("waitForAgentReady — LT-7 success", () => {
  test("resolves only after the entry appears AND health returns 2xx, then stops", async () => {
    let loadCalls = 0;
    let probeCalls = 0;
    const loadRecords = async (): Promise<AgentRegistryRecord[]> => {
      loadCalls += 1;
      // absent for the first two polls, then registered.
      return loadCalls < 3 ? [] : [rec({ name: "pi-a", url: "http://10.0.0.219:49622" })];
    };
    const probe = async (): Promise<{ status: number }> => {
      probeCalls += 1;
      return { status: probeCalls < 2 ? 503 : 200 }; // 503 once, then 200
    };
    const statuses: string[] = [];

    const url = await waitForAgentReady({
      agent: "pi-a",
      loadRecords,
      probe,
      now: () => 0, // never times out
      sleep: async () => {},
      onStatus: (s) => statuses.push(s),
    });

    expect(url).toBe("http://10.0.0.219:49622");
    expect(loadCalls).toBe(4); // absent, absent, (503), (200)
    expect(probeCalls).toBe(2); // 503 then 200; stops immediately on 200
    expect(statuses).toEqual(["absent", "absent", "health 503", "ready"]);
  });
});

// LT-8 ----------------------------------------------------------------------
describe("waitForAgentReady — LT-8 timeout", () => {
  test("throws ReadinessTimeoutError when the budget elapses, never resolving", async () => {
    let t = 0;
    const clock = (): number => {
      const v = t;
      t += 20_000; // each call advances 20s
      return v;
    };
    let probeCalls = 0;

    const promise = waitForAgentReady({
      agent: "pi-x",
      loadRecords: async () => [], // never registers
      probe: async () => {
        probeCalls += 1;
        return { status: 200 };
      },
      now: clock,
      sleep: async () => {},
      timeoutMs: 30_000,
    });

    await expect(promise).rejects.toBeInstanceOf(ReadinessTimeoutError);
    await promise.catch((e: ReadinessTimeoutError) => {
      expect(e.agent).toBe("pi-x");
      expect(e.lastStatus).toBe("absent");
    });
    expect(probeCalls).toBe(0); // never reached the health probe (entry absent)
  });
});

// command wiring ------------------------------------------------------------
describe("runClientCommand — --agent wiring", () => {
  test("resolves --agent to a base-mode target and hands it to the app", async () => {
    let captured: StartClientAppOptions | undefined;
    const code = await runClientCommand(["--agent", "pi-a"], {
      loadRegistryRecords: async () => [rec({ name: "pi-a", url: "http://10.0.0.219:49622" })],
      runApp: async (options) => {
        captured = options;
        return 0;
      },
      output: { write: () => true },
    });
    expect(code).toBe(0);
    expect(captured?.target).toEqual({
      url: "http://10.0.0.219:49622",
      headers: {},
      mode: "base",
    });
  });

  test("--agent --wait gates on readiness before connecting", async () => {
    let captured: StartClientAppOptions | undefined;
    const code = await runClientCommand(["--agent", "pi-a", "--wait"], {
      loadRegistryRecords: async () => [rec({ name: "pi-a", url: "http://10.0.0.219:49622" })],
      probe: async () => ({ status: 200 }),
      now: () => 0,
      sleep: async () => {},
      runApp: async (options) => {
        captured = options;
        return 0;
      },
      output: { write: () => true },
    });
    expect(code).toBe(0);
    expect(captured?.target.url).toBe("http://10.0.0.219:49622");
  });

  test("--agent --wait default health probe passes an abort signal to fetch", async () => {
    const originalFetch = globalThis.fetch;
    const signals: AbortSignal[] = [];
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const init = args[1];
      if (init?.signal) {
        signals.push(init.signal);
      }
      return new Response("", { status: 200 });
    }) as typeof fetch;
    try {
      const code = await runClientCommand(["--agent", "pi-a", "--wait"], {
        loadRegistryRecords: async () => [rec({ name: "pi-a", url: "http://10.0.0.219:49622" })],
        now: () => 0,
        sleep: async () => {},
        runApp: async () => 0,
        output: { write: () => true },
      });
      expect(code).toBe(0);
      expect(signals).toHaveLength(1);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects combining --agent with --url (exactly one target)", async () => {
    const code = await runClientCommand(["--agent", "pi-a", "--url", "http://x"], {
      runApp: async () => 0,
      output: { write: () => true },
    });
    expect(code).toBe(64);
  });

  test("rejects --wait without --agent instead of silently ignoring it", async () => {
    const code = await runClientCommand(["--url", "http://10.0.0.219:49622", "--wait"], {
      runApp: async () => 0,
      output: { write: () => true },
    });
    expect(code).toBe(64);
  });
});
