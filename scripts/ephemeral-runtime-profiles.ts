import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type GatewayRuntimeId, writeAgentsJsConfig } from "@agents-js/gateway-runtime";
import {
  E2E_RUNTIME_PROFILE_CONFIG_HOME_ENV,
  E2E_RUNTIME_PROFILE_DATA_HOME_ENV,
  E2E_RUNTIME_PROFILE_PREFIX_ENV,
  E2E_RUNTIME_PROFILE_RUNTIMES_ENV,
  E2E_RUNTIME_PROFILE_STATE_HOME_ENV,
} from "@agents-js/host";

export interface EphemeralRuntimeProfileSandbox {
  cleanup(): Promise<void>;
  configPath: string;
  env: Record<string, string>;
  profilePrefix: string;
  tempRoot: string;
}

function sanitizePrefixSeed(seed: string): string {
  const normalized = seed
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-");
  return normalized.replace(/^-|-$/g, "") || "runtime-e2e";
}

function buildProfileDefinition(runtimeId: GatewayRuntimeId, profileName: string) {
  if (runtimeId === "opencode") {
    return {
      runtime: runtimeId,
      env: {
        OPENCODE_PROFILE: profileName,
      },
    };
  }

  return {
    runtime: runtimeId,
  };
}

export async function createEphemeralRuntimeProfileSandbox(
  seed: string,
  runtimeIds: GatewayRuntimeId[] = ["opencode"],
): Promise<EphemeralRuntimeProfileSandbox> {
  const safeSeed = sanitizePrefixSeed(seed);
  const tempRoot = await mkdtemp(path.join(tmpdir(), `agents-js-${safeSeed}-`));
  const xdgConfigHome = path.join(tempRoot, "xdg-config");
  const xdgDataHome = path.join(tempRoot, "xdg-data");
  const xdgStateHome = path.join(tempRoot, "xdg-state");
  const configPath = path.join(xdgConfigHome, "agents-js", "config.json");
  const profilePrefix = `${safeSeed}-${randomUUID().slice(0, 8)}`;

  await Promise.all([
    mkdir(xdgConfigHome, { recursive: true }),
    mkdir(xdgDataHome, { recursive: true }),
    mkdir(xdgStateHome, { recursive: true }),
  ]);

  await writeAgentsJsConfig(configPath, {
    profiles: Object.fromEntries(
      runtimeIds.map((runtimeId) => {
        const profileName = `${profilePrefix}-${runtimeId}`;
        return [profileName, buildProfileDefinition(runtimeId, profileName)];
      }),
    ),
  });

  return {
    tempRoot,
    configPath,
    profilePrefix,
    env: {
      [E2E_RUNTIME_PROFILE_CONFIG_HOME_ENV]: xdgConfigHome,
      [E2E_RUNTIME_PROFILE_DATA_HOME_ENV]: xdgDataHome,
      [E2E_RUNTIME_PROFILE_PREFIX_ENV]: profilePrefix,
      [E2E_RUNTIME_PROFILE_RUNTIMES_ENV]: runtimeIds.join(","),
      [E2E_RUNTIME_PROFILE_STATE_HOME_ENV]: xdgStateHome,
    },
    async cleanup() {
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}
