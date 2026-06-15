/**
 * Learning tests for the cockpit plan flag + pi env (the harness-pure half;
 * the CLI window orchestration is covered in packages/cli/tests/launch.test.ts).
 *
 * LT-3: buildLaunchPlan carries cockpit for a pi entry; non-cockpit pi and other
 *       harnesses stay single-window; cockpit on a non-pi harness is rejected.
 * LT-4: the pi plan's sessionEnv carries AGENTS_JS_PI_NATIVE/_NAME/_HOST.
 * LT-10: pi_host resolution — "lan"→resolver, explicit→literal, unresolved→absent.
 */
import { describe, expect, test } from "bun:test";
import {
  type AgentEntry,
  buildLaunchPlan,
  type LaunchEnv,
  resolvePiAdvertiseHost,
} from "../../src/index.ts";

const entry = (over: Partial<AgentEntry> = {}): AgentEntry => ({
  tmuxSession: "pi-x",
  harness: "pi",
  binary: "pi",
  workspace: "/tmp/ws",
  freshFlags: "",
  extra: {},
  ...over,
});

const plan = (
  e: AgentEntry,
  opts: { baseEnv?: LaunchEnv; resolveLanHost?: () => string | undefined } = {},
) => buildLaunchPlan(e, { baseEnv: opts.baseEnv ?? {}, resolveLanHost: opts.resolveLanHost });

// LT-3 ----------------------------------------------------------------------
describe("buildLaunchPlan — LT-3: cockpit flag", () => {
  test("a pi entry with cockpit=true sets plan.cockpit", () => {
    expect(plan(entry({ cockpit: true })).cockpit).toBe(true);
  });

  test("a pi entry without cockpit stays single-window", () => {
    expect(plan(entry({})).cockpit).toBe(false);
  });

  test("cockpit on a non-pi harness is rejected", () => {
    expect(() => plan(entry({ harness: "claude-code", binary: "claude", cockpit: true }))).toThrow(
      /cockpit is only supported for the "pi" harness/,
    );
  });
});

// LT-4 ----------------------------------------------------------------------
describe("buildLaunchPlan — LT-4: pi native env in sessionEnv", () => {
  test("sessionEnv carries AGENTS_JS_PI_NATIVE/_NAME and defaults name to the session", () => {
    const p = plan(entry({ tmuxSession: "pi-a" }));
    expect(p.sessionEnv.AGENTS_JS_PI_NATIVE).toBe("1");
    expect(p.sessionEnv.AGENTS_JS_PI_NAME).toBe("pi-a");
  });
});

// LT-10 ---------------------------------------------------------------------
describe("buildLaunchPlan — LT-10: host-agnostic pi_host", () => {
  test('"lan" resolves through the injected LAN resolver', () => {
    const p = plan(entry({ piHost: "lan" }), { resolveLanHost: () => "box.lan" });
    expect(p.env.AGENTS_JS_PI_HOST).toBe("box.lan");
    expect(p.sessionEnv.AGENTS_JS_PI_HOST).toBe("box.lan");
  });

  test("an explicit host is used literally (no LAN resolution)", () => {
    const p = plan(entry({ piHost: "127.0.0.1" }), { resolveLanHost: () => "box.lan" });
    expect(p.env.AGENTS_JS_PI_HOST).toBe("127.0.0.1");
  });

  test("an unresolvable LAN leaves AGENTS_JS_PI_HOST unset", () => {
    const p = plan(entry({ piHost: undefined }), { resolveLanHost: () => undefined });
    expect(p.env.AGENTS_JS_PI_HOST).toBeUndefined();
  });

  test("the exported resolver matches launch semantics for onboard dispatch", () => {
    let resolverCalls = 0;
    const host = resolvePiAdvertiseHost("127.0.0.1", () => {
      resolverCalls++;
      return "box.lan";
    });
    expect(host).toBe("127.0.0.1");
    expect(resolverCalls).toBe(0);
  });
});
