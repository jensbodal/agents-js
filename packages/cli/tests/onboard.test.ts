/**
 * Tests for the `agents-js onboard` mesh-join emit helpers (#41 option b).
 * The launch wiring itself is covered by launch.test.ts; here we lock the two
 * pure functions that shape the emitted dispatch entry.
 */
import { describe, expect, test } from "bun:test";
import {
  buildMeshJoinDispatchEntry,
  parseOnboardTarget,
  runOnboardCommand,
} from "../src/onboard.ts";

describe("parseOnboardTarget", () => {
  test("takes the first non-flag token as the agent name", () => {
    expect(parseOnboardTarget(["cognee-claude"]).agentName).toBe("cognee-claude");
    expect(parseOnboardTarget(["cognee-claude", "--bg"]).agentName).toBe("cognee-claude");
    expect(parseOnboardTarget(["--bg", "cognee-claude"]).agentName).toBe("cognee-claude");
  });

  test("extracts an explicit --config value without mistaking it for the agent", () => {
    const before = parseOnboardTarget(["--config", "/tmp/agents.json", "mdg-pi-0"]);
    expect(before.agentName).toBe("mdg-pi-0");
    expect(before.configPath).toBe("/tmp/agents.json");

    const after = parseOnboardTarget(["mdg-pi-0", "--config", "/tmp/agents.json"]);
    expect(after.agentName).toBe("mdg-pi-0");
    expect(after.configPath).toBe("/tmp/agents.json");
  });

  test("returns undefined agent when no positional is present", () => {
    expect(parseOnboardTarget(["--help"]).agentName).toBeUndefined();
    expect(parseOnboardTarget([]).agentName).toBeUndefined();
  });
});

describe("buildMeshJoinDispatchEntry", () => {
  test("builds an FQDN-based a2a url when a fixed port + host resolve", () => {
    const entry = buildMeshJoinDispatchEntry("mdg-pi-0", "3199", "mdg.q4m.dev");
    expect(entry).toEqual({ name: "mdg-pi-0", url: "http://mdg.q4m.dev:3199" });
  });

  test("returns null without a fixed A2A port (ephemeral peers self-register locally)", () => {
    expect(buildMeshJoinDispatchEntry("mdg-pi-0", undefined, "mdg.q4m.dev")).toBeNull();
    expect(buildMeshJoinDispatchEntry("mdg-pi-0", "", "mdg.q4m.dev")).toBeNull();
  });

  test("returns null when no advertise host resolves", () => {
    expect(buildMeshJoinDispatchEntry("mdg-pi-0", "3199", undefined)).toBeNull();
  });
});

describe("runOnboardCommand --help", () => {
  function capture(): { sink: { write: (s: string) => boolean }; text: () => string } {
    const chunks: string[] = [];
    return {
      sink: {
        write: (s: string) => {
          chunks.push(s);
          return true;
        },
      },
      text: () => chunks.join(""),
    };
  }

  // Regression: --help must short-circuit BEFORE the launch path, so it prints
  // onboard's own usage — not launch's help wrapped in launching/launched
  // banners (and never actually launching a session).
  for (const flag of ["--help", "-h"]) {
    test(`\`onboard ${flag}\` prints onboard usage and skips the launch path`, async () => {
      const out = capture();
      const code = await runOnboardCommand([flag], {
        output: out.sink as unknown as Pick<NodeJS.WriteStream, "write">,
      });
      const text = out.text();
      expect(code).toBe(0);
      expect(text).toContain("agents-js onboard <agent-name>");
      expect(text).toContain("mesh-join dispatch entry");
      expect(text).not.toContain("launching agent onto the mesh");
      expect(text).not.toContain("harness launched");
    });
  }
});
