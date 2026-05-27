import { normalizePermissionMode, type PermissionMode } from "@agents-js/acp-host";
import { normalizeGatewayPublicUrl, parseGatewayPort } from "./discovery.ts";

export const VALID_PERMISSION_MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "unattendedGateway",
];

/**
 * CLI kebab-case aliases for canonical {@link PermissionMode} strings.
 * `normalizePermissionMode` accepts both kebab and camelCase; the allow-list
 * here lets operators type the more natural kebab form (`unattended-gateway`)
 * without it being rejected as an unknown mode.
 */
const KEBAB_PERMISSION_MODE_ALIASES = ["unattended-gateway"] as const;

/**
 * Legacy CLI strings (`ask`/`yolo`/`hub`) accepted for one release cycle.
 * Operators get a `normalizePermissionMode` deprecation warning if they
 * pass a legacy string; the value is mapped to canonical before reaching
 * the controller.
 */
const LEGACY_PERMISSION_MODES = ["ask", "yolo", "hub"] as const;

export interface GatewayCliArgs {
  check: boolean;
  defaultModel?: string;
  heartbeatEnabled: boolean;
  heartbeatIntervalMs?: number;
  hostname?: string;
  permissionMode: PermissionMode;
  port?: number;
  publicUrl?: string;
  registrySync: boolean;
  /**
   * Ordered list of curated runtime ids. Index 0 is the primary
   * routing target; subsequent entries are secondary (parsed by the
   * CLI, lazy-spawned by the lane manager). `--runtime` (singular)
   * and `--runtimes` (comma-separated, repeatable) both populate this
   * list in argv order. A single-runtime invocation (`--runtime
   * opencode` alone) yields a 1-element list — the original
   * single-runtime behavior is preserved by downstream consumers
   * reading `runtimeOverrides[0]`.
   */
  runtimeOverrides: readonly string[];
  trustWorkspace: boolean;
  workspace: string;
}

/**
 * Resolve the trust-workspace gate from CLI args + env. Mirrors the
 * `shouldEnableRegistrySync` gate in the published CLI: explicit
 * literal `"true"` only — non-boolean truthy strings are rejected so
 * an operator does not cross the workspace-trust boundary by accident.
 */
function resolveTrustWorkspace(flagPresent: boolean, env: NodeJS.ProcessEnv): boolean {
  if (flagPresent) return true;
  return env.AGENTS_JS_TRUST_WORKSPACE === "true";
}

/**
 * Resolve the registry-sync gate from CLI args + env. The internal
 * gateway mirrors the published `agents-js serve` policy: peer sync
 * is opt-in only and the env var must be the literal string `"true"`.
 * Truthy variants (`"1"`, `"yes"`, etc.) are rejected so an operator
 * does not enable a network surface by accident.
 */
function resolveRegistrySync(flagPresent: boolean, env: NodeJS.ProcessEnv): boolean {
  if (flagPresent) return true;
  return env.AGENTS_JS_REGISTRY_SYNC === "true";
}

/**
 * Resolve the host-address heartbeat enable gate (AJS-87). Mirrors
 * {@link resolveRegistrySync}: explicit literal `"true"` / `"false"`
 * only — non-boolean truthy strings are rejected so a publication
 * cadence cannot flip by accident. Default is `true` (heartbeat on).
 *
 * `--heartbeat-enabled` and `--no-heartbeat` set `explicitValue`
 * directly; when both flags appear the argv parser passes the
 * left-to-right final value, matching the conventional `--no-foo` /
 * `--foo` precedence.
 */
function resolveHeartbeatEnabled(
  explicitValue: boolean | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  if (explicitValue !== undefined) return explicitValue;
  const raw = env.AGENTS_JS_HEARTBEAT_ENABLED;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw !== undefined && raw !== "") {
    throw new Error(
      `[Gateway] Invalid AGENTS_JS_HEARTBEAT_ENABLED "${raw}". Expected literal "true" or "false".`,
    );
  }
  return true;
}

/**
 * Resolve the host-address heartbeat interval (AJS-87). CLI value wins,
 * then env var, then `undefined` (the heartbeat helper substitutes its
 * 60 000 ms default). Rejects non-numeric or negative env values so a
 * typo cannot silently fall back to the default cadence.
 */
function resolveHeartbeatIntervalMs(
  explicitValue: number | undefined,
  env: NodeJS.ProcessEnv,
): number | undefined {
  if (explicitValue !== undefined) return explicitValue;
  const raw = env.AGENTS_JS_HEARTBEAT_INTERVAL_MS;
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `[Gateway] Invalid AGENTS_JS_HEARTBEAT_INTERVAL_MS "${raw}". Expected a non-negative number.`,
    );
  }
  return parsed;
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv): GatewayCliArgs {
  let check = false;
  const runtimeOverrides: string[] = [];
  let workspace: string = process.cwd();
  let permissionMode: PermissionMode = "default";
  let defaultModel: string | undefined;
  let hostname: string | undefined;
  let port: number | undefined;
  let publicUrl: string | undefined;
  let trustWorkspaceFlag = false;
  let registrySyncFlag = false;
  let heartbeatEnabledFlag: boolean | undefined;
  let heartbeatIntervalMsFlag: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      check = true;
      continue;
    }

    if (arg === "--runtime") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('[Gateway] Missing value for "--runtime".');
      }
      runtimeOverrides.push(next);
      index += 1;
      continue;
    }

    if (arg === "--runtimes") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('[Gateway] Missing value for "--runtimes".');
      }
      for (const part of next.split(",").map((s) => s.trim())) {
        if (part.length === 0) {
          throw new Error(
            "[Gateway] --runtimes value contains an empty entry; comma-separate non-empty ids only.",
          );
        }
        runtimeOverrides.push(part);
      }
      index += 1;
      continue;
    }

    if (arg === "--workspace") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('[Gateway] Missing value for "--workspace".');
      }
      workspace = next;
      index += 1;
      continue;
    }

    if (arg === "--permission-mode") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('[Gateway] Missing value for "--permission-mode".');
      }
      const isCanonical = VALID_PERMISSION_MODES.includes(next as PermissionMode);
      const isKebab = (KEBAB_PERMISSION_MODE_ALIASES as readonly string[]).includes(next);
      const isLegacy = (LEGACY_PERMISSION_MODES as readonly string[]).includes(next);
      if (!isCanonical && !isKebab && !isLegacy) {
        throw new Error(
          `[Gateway] Invalid permission mode "${next}". Valid modes: ${VALID_PERMISSION_MODES.join(", ")} (kebab aliases ${KEBAB_PERMISSION_MODE_ALIASES.join("/")} also accepted; legacy aliases ${LEGACY_PERMISSION_MODES.join("/")} accepted with deprecation warning).`,
        );
      }
      permissionMode = normalizePermissionMode(next);
      index += 1;
      continue;
    }

    if (arg === "--default-model") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('[Gateway] Missing value for "--default-model".');
      }
      defaultModel = next;
      index += 1;
      continue;
    }

    if (arg === "--port") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('[Gateway] Missing value for "--port".');
      }
      port = parseGatewayPort(next, "--port");
      index += 1;
      continue;
    }

    if (arg === "--hostname") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('[Gateway] Missing value for "--hostname".');
      }
      hostname = next;
      index += 1;
      continue;
    }

    if (arg === "--public-url") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('[Gateway] Missing value for "--public-url".');
      }
      publicUrl = normalizeGatewayPublicUrl(next, "--public-url");
      index += 1;
      continue;
    }

    if (arg === "--trust-workspace") {
      trustWorkspaceFlag = true;
      continue;
    }

    if (arg === "--registry-sync") {
      registrySyncFlag = true;
      continue;
    }

    if (arg === "--heartbeat-enabled") {
      heartbeatEnabledFlag = true;
      continue;
    }

    if (arg === "--no-heartbeat") {
      heartbeatEnabledFlag = false;
      continue;
    }

    if (arg === "--heartbeat-interval-ms") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('[Gateway] Missing value for "--heartbeat-interval-ms".');
      }
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(
          `[Gateway] Invalid --heartbeat-interval-ms "${next}". Expected a non-negative number.`,
        );
      }
      heartbeatIntervalMsFlag = parsed;
      index += 1;
      continue;
    }

    throw new Error(
      `[Gateway] Unknown argument "${arg}". Supported args: --check, --runtime <id>, --runtimes <id1,id2,...>, --workspace <path>, --permission-mode <mode>, --default-model <id>, --port <port>, --hostname <host>, --public-url <url>, --trust-workspace, --registry-sync, --heartbeat-enabled, --no-heartbeat, --heartbeat-interval-ms <ms>.`,
    );
  }

  const trustWorkspace = resolveTrustWorkspace(trustWorkspaceFlag, env);
  const registrySync = resolveRegistrySync(registrySyncFlag, env);
  const heartbeatEnabled = resolveHeartbeatEnabled(heartbeatEnabledFlag, env);
  const heartbeatIntervalMs = resolveHeartbeatIntervalMs(heartbeatIntervalMsFlag, env);
  const envPublicUrl =
    env.AGENTS_JS_PUBLIC_URL !== undefined && env.AGENTS_JS_PUBLIC_URL.trim() !== ""
      ? normalizeGatewayPublicUrl(env.AGENTS_JS_PUBLIC_URL, "AGENTS_JS_PUBLIC_URL")
      : undefined;

  return {
    check,
    runtimeOverrides,
    workspace,
    permissionMode,
    defaultModel,
    hostname,
    port,
    publicUrl: publicUrl ?? envPublicUrl,
    trustWorkspace,
    registrySync,
    heartbeatEnabled,
    heartbeatIntervalMs,
  };
}
