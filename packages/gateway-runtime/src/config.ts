import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { validateRuntimeProfileName } from "./profiles/name.ts";
import type {
  CuratedGatewayRuntimeSelection,
  CustomGatewayRuntimeSelection,
  GatewayRuntimeId,
  GatewayRuntimeProfile,
  GatewayRuntimeSelection,
} from "./runtimes-registry.ts";

export type HarnessSelectionPolicy = "ask-each-time" | "prefer-saved";

export interface AgentsJsServeConfig {
  harness?: GatewayRuntimeSelection;
  host?: string;
  port?: number;
  selectionPolicy?: HarnessSelectionPolicy;
  defaultModel?: string;
}

export interface AgentsJsConfig {
  extraBinPaths?: string[];
  profiles?: Record<string, GatewayRuntimeProfile>;
  serve?: AgentsJsServeConfig;
}

export interface ConfigPathOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface AgentsJsConfigPaths {
  userConfigPath: string;
  projectConfigPath: string;
  projectExamplePath: string;
}

export interface LoadedAgentsJsConfig {
  paths: AgentsJsConfigPaths;
  userConfig?: AgentsJsConfig;
  projectConfig?: AgentsJsConfig;
  effectiveConfig: AgentsJsConfig;
}

export const DEFAULT_AGENTS_JS_CONFIG: AgentsJsConfig = Object.freeze({
  serve: Object.freeze({
    harness: Object.freeze({ kind: "curated" as const, runtime: "claude" as const }),
  }),
} as AgentsJsConfig);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSelectionPolicy(
  value: unknown,
  filePath: string,
): HarnessSelectionPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "ask-each-time" || value === "prefer-saved") {
    return value;
  }

  throw new Error(
    `[agents-js] Invalid selectionPolicy in ${filePath}. Expected "ask-each-time" or "prefer-saved".`,
  );
}

function parseHarnessConfig(value: unknown, filePath: string): GatewayRuntimeSelection | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isObject(value) || typeof value.kind !== "string") {
    throw new Error(`[agents-js] Invalid harness configuration in ${filePath}.`);
  }

  if (value.kind === "curated") {
    if (typeof value.runtime !== "string") {
      throw new Error(`[agents-js] Curated harness in ${filePath} must include a runtime id.`);
    }

    return {
      kind: "curated",
      profile:
        value.profile === undefined
          ? undefined
          : typeof value.profile === "string"
            ? validateRuntimeProfileName(value.profile)
            : (() => {
                throw new Error(
                  `[agents-js] Curated harness profile in ${filePath} must be a string.`,
                );
              })(),
      runtime: value.runtime as GatewayRuntimeId,
    } satisfies CuratedGatewayRuntimeSelection;
  }

  if (value.kind === "custom") {
    if (typeof value.command !== "string" || value.command.trim() === "") {
      throw new Error(`[agents-js] Custom harness in ${filePath} must include a command.`);
    }

    const args =
      value.args === undefined
        ? undefined
        : Array.isArray(value.args) && value.args.every((entry) => typeof entry === "string")
          ? [...value.args]
          : (() => {
              throw new Error(
                `[agents-js] Custom harness args in ${filePath} must be an array of strings.`,
              );
            })();

    return {
      kind: "custom",
      command: value.command,
      args,
      displayName: typeof value.displayName === "string" ? value.displayName : undefined,
      description: typeof value.description === "string" ? value.description : undefined,
    } satisfies CustomGatewayRuntimeSelection;
  }

  throw new Error(`[agents-js] Unsupported harness kind in ${filePath}: ${String(value.kind)}`);
}

function parseStringArray(
  value: unknown,
  filePath: string,
  fieldName: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`[agents-js] ${fieldName} in ${filePath} must be an array of strings.`);
  }

  return [...value];
}

function parseStringRecord(
  value: unknown,
  filePath: string,
  fieldName: string,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isObject(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new Error(`[agents-js] ${fieldName} in ${filePath} must be an object of strings.`);
  }

  return { ...value } as Record<string, string>;
}

function parseProfileRoots(
  value: unknown,
  filePath: string,
): GatewayRuntimeProfile["roots"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = parseStringRecord(value, filePath, "Runtime profile roots");
  return parsed
    ? {
        home: parsed.home,
        config: parsed.config,
        data: parsed.data,
        state: parsed.state,
        cache: parsed.cache,
      }
    : undefined;
}

function parseProfilesConfig(
  value: unknown,
  filePath: string,
): Record<string, GatewayRuntimeProfile> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isObject(value)) {
    throw new Error(`[agents-js] Invalid profiles config in ${filePath}. Expected an object.`);
  }

  const profiles: Record<string, GatewayRuntimeProfile> = {};

  for (const [profileName, profileValue] of Object.entries(value)) {
    const normalizedName = validateRuntimeProfileName(profileName);
    if (!isObject(profileValue) || typeof profileValue.runtime !== "string") {
      throw new Error(
        `[agents-js] Runtime profile "${profileName}" in ${filePath} must include a runtime id.`,
      );
    }

    profiles[normalizedName] = {
      runtime: profileValue.runtime as GatewayRuntimeId,
      roots: parseProfileRoots(profileValue.roots, filePath),
      env: parseStringRecord(profileValue.env, filePath, `Runtime profile "${profileName}" env`),
      args: parseStringArray(profileValue.args, filePath, `Runtime profile "${profileName}" args`),
    };
  }

  return profiles;
}

function parsePort(value: unknown, filePath: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`[agents-js] Invalid port in ${filePath}. Expected an integer 0-65535.`);
  }

  return value;
}

function parseServeConfig(value: unknown, filePath: string): AgentsJsServeConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isObject(value)) {
    throw new Error(`[agents-js] Invalid serve config in ${filePath}. Expected an object.`);
  }

  const host =
    value.host === undefined
      ? undefined
      : typeof value.host === "string" && value.host.trim() !== ""
        ? value.host
        : (() => {
            throw new Error(
              `[agents-js] Invalid host in ${filePath}. Expected a non-empty string.`,
            );
          })();

  const defaultModel =
    value.defaultModel === undefined
      ? undefined
      : typeof value.defaultModel === "string" && value.defaultModel.trim() !== ""
        ? value.defaultModel
        : (() => {
            throw new Error(
              `[agents-js] Invalid defaultModel in ${filePath}. Expected a non-empty string.`,
            );
          })();

  return {
    selectionPolicy: parseSelectionPolicy(value.selectionPolicy, filePath),
    harness: parseHarnessConfig(value.harness, filePath),
    host,
    port: parsePort(value.port, filePath),
    defaultModel,
  };
}

export function parseAgentsJsConfig(value: unknown, filePath: string): AgentsJsConfig {
  if (!isObject(value)) {
    throw new Error(`[agents-js] Config in ${filePath} must be a JSON object.`);
  }

  return {
    extraBinPaths: parseStringArray(value.extraBinPaths, filePath, "extraBinPaths"),
    profiles: parseProfilesConfig(value.profiles, filePath),
    serve: parseServeConfig(value.serve, filePath),
  };
}

export function getAgentsJsConfigPaths(options: ConfigPathOptions = {}): AgentsJsConfigPaths {
  const cwd = options.cwd ?? process.cwd();
  // biome-ignore lint/style/noProcessEnv: node-side config loading defaults to the live process environment when no override is injected.
  const env = options.env ?? process.env;
  const resolvedHome = options.homeDir ?? env.HOME ?? homedir();
  const xdgConfigHome = env.XDG_CONFIG_HOME ?? path.join(resolvedHome, ".config");

  return {
    userConfigPath: path.join(xdgConfigHome, "agents-js", "config.json"),
    projectConfigPath: path.join(cwd, ".agents-js", "config.json"),
    projectExamplePath: path.join(cwd, ".agents-js", "config.example.json"),
  };
}

async function readConfigFile(filePath: string): Promise<AgentsJsConfig | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    return parseAgentsJsConfig(JSON.parse(raw), filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function mergeServeConfig(
  userConfig?: AgentsJsServeConfig,
  projectConfig?: AgentsJsServeConfig,
): AgentsJsServeConfig | undefined {
  if (!userConfig && !projectConfig) {
    return undefined;
  }

  return {
    selectionPolicy: projectConfig?.selectionPolicy ?? userConfig?.selectionPolicy,
    harness: projectConfig?.harness ?? userConfig?.harness,
    host: projectConfig?.host ?? userConfig?.host,
    port: projectConfig?.port ?? userConfig?.port,
    defaultModel: projectConfig?.defaultModel ?? userConfig?.defaultModel,
  };
}

function mergeProfilesConfig(
  userProfiles?: Record<string, GatewayRuntimeProfile>,
  projectProfiles?: Record<string, GatewayRuntimeProfile>,
): Record<string, GatewayRuntimeProfile> | undefined {
  if (!userProfiles && !projectProfiles) {
    return undefined;
  }

  const names = new Set([
    ...Object.keys(userProfiles ?? {}),
    ...Object.keys(projectProfiles ?? {}),
  ]);

  const merged: Record<string, GatewayRuntimeProfile> = {};
  for (const name of names) {
    const userProfile = userProfiles?.[name];
    const projectProfile = projectProfiles?.[name];
    if (!userProfile) {
      merged[name] = projectProfile as GatewayRuntimeProfile;
      continue;
    }
    if (!projectProfile) {
      merged[name] = userProfile;
      continue;
    }
    merged[name] = {
      ...userProfile,
      ...projectProfile,
      env: { ...(projectProfile.env ?? {}), ...(userProfile.env ?? {}) },
    };
  }
  return merged;
}

export function mergeAgentsJsConfig(
  userConfig?: AgentsJsConfig,
  projectConfig?: AgentsJsConfig,
): AgentsJsConfig {
  return {
    extraBinPaths: projectConfig?.extraBinPaths ?? userConfig?.extraBinPaths,
    profiles: mergeProfilesConfig(userConfig?.profiles, projectConfig?.profiles),
    serve: mergeServeConfig(userConfig?.serve, projectConfig?.serve),
  };
}

export async function loadAgentsJsConfig(
  options: ConfigPathOptions = {},
): Promise<LoadedAgentsJsConfig> {
  const paths = getAgentsJsConfigPaths(options);
  const [userConfig, projectConfig] = await Promise.all([
    readConfigFile(paths.userConfigPath),
    readConfigFile(paths.projectConfigPath),
  ]);

  return {
    paths,
    userConfig,
    projectConfig,
    effectiveConfig: mergeAgentsJsConfig(
      DEFAULT_AGENTS_JS_CONFIG,
      mergeAgentsJsConfig(userConfig, projectConfig),
    ),
  };
}

export async function writeAgentsJsConfig(filePath: string, config: AgentsJsConfig): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
