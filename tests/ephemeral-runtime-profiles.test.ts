import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  E2E_RUNTIME_PROFILE_CONFIG_HOME_ENV,
  E2E_RUNTIME_PROFILE_DATA_HOME_ENV,
  E2E_RUNTIME_PROFILE_PREFIX_ENV,
  E2E_RUNTIME_PROFILE_RUNTIMES_ENV,
  E2E_RUNTIME_PROFILE_STATE_HOME_ENV,
} from "@agents-js/host";
import { createEphemeralRuntimeProfileSandbox } from "../scripts/ephemeral-runtime-profiles.ts";

const sandboxes: Array<{ cleanup(): Promise<void> }> = [];

afterEach(async () => {
  while (sandboxes.length > 0) {
    await sandboxes
      .pop()
      ?.cleanup()
      .catch(() => {});
  }
});

describe("createEphemeralRuntimeProfileSandbox", () => {
  test("creates isolated runtime profiles and user config for the selected runtimes", async () => {
    const sandbox = await createEphemeralRuntimeProfileSandbox("web ui live e2e");
    sandboxes.push(sandbox);

    const persisted = JSON.parse(await readFile(sandbox.configPath, "utf8")) as {
      profiles: Record<
        string,
        {
          env?: Record<string, string>;
          runtime: string;
        }
      >;
    };

    expect(sandbox.profilePrefix).toMatch(/^web-ui-live-e2e-[a-f0-9]{8}$/);
    expect(sandbox.env[E2E_RUNTIME_PROFILE_CONFIG_HOME_ENV]).toBeDefined();
    expect(sandbox.env[E2E_RUNTIME_PROFILE_DATA_HOME_ENV]).toBeDefined();
    expect(sandbox.env[E2E_RUNTIME_PROFILE_PREFIX_ENV]).toBe(sandbox.profilePrefix);
    expect(sandbox.env[E2E_RUNTIME_PROFILE_RUNTIMES_ENV]).toBe("opencode");
    expect(sandbox.env[E2E_RUNTIME_PROFILE_STATE_HOME_ENV]).toBeDefined();
    expect(existsSync(sandbox.env[E2E_RUNTIME_PROFILE_CONFIG_HOME_ENV] as string)).toBe(true);
    expect(existsSync(sandbox.env[E2E_RUNTIME_PROFILE_DATA_HOME_ENV] as string)).toBe(true);
    expect(existsSync(sandbox.env[E2E_RUNTIME_PROFILE_STATE_HOME_ENV] as string)).toBe(true);

    const profileName = `${sandbox.profilePrefix}-opencode`;

    expect(persisted.profiles).toEqual({
      [profileName]: {
        runtime: "opencode",
        env: {
          OPENCODE_PROFILE: profileName,
        },
      },
    });
  });
});
