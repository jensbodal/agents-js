import { describe, expect, test } from "bun:test";
import { gatewayConfig } from "../apps/internal-gateway/gateway.config.ts";
import { parseDevArgs } from "../scripts/dev.ts";
import { assertSourceLinked, parseDoctorArgs } from "../scripts/doctor.ts";
import { repoRoot } from "../scripts/workspace-config.ts";

describe("dev runtime args", () => {
  test("defaults to the checked-in gateway runtime", () => {
    expect(parseDevArgs([])).toEqual({ runtime: gatewayConfig.runtime });
    expect(parseDoctorArgs([])).toEqual({ runtime: gatewayConfig.runtime });
  });

  test("accepts explicit runtimes", () => {
    expect(parseDevArgs(["--runtime", "claude"])).toEqual({ runtime: "claude" });
    expect(parseDoctorArgs(["--runtime", "claude"])).toEqual({ runtime: "claude" });
  });

  test("rejects invalid runtimes", () => {
    expect(() => parseDevArgs(["--runtime", "missing-runtime"])).toThrow(
      'Unknown runtime "missing-runtime"',
    );
    expect(() => parseDoctorArgs(["--runtime", "missing-runtime"])).toThrow(
      'Unknown runtime "missing-runtime"',
    );
  });

  test("accepts a source alias when runtime package exports are not built yet", async () => {
    await expect(
      assertSourceLinked(`${repoRoot}/apps/internal-gateway`, "@agents-js/gateway-runtime", {
        resolveSpecifier: async () => {
          throw new Error("Cannot find module '@agents-js/gateway-runtime'");
        },
      }),
    ).resolves.toBeUndefined();
  });

  test("fails when runtime resolution breaks and no source alias exists", async () => {
    await expect(
      assertSourceLinked("/tmp/repo", "@agents-js/gateway-runtime", {
        resolveSpecifier: async () => {
          throw new Error("Cannot find module '@agents-js/gateway-runtime'");
        },
      }),
    ).rejects.toThrow("No source alias target found.");
  });
});
