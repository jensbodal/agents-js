import { normalizePermissionMode, type PermissionMode } from "@agents-js/acp-host";
import { parseGatewayPort } from "./discovery.ts";

export const VALID_PERMISSION_MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

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
  hostname?: string;
  permissionMode: PermissionMode;
  port?: number;
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

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv): GatewayCliArgs {
  let check = false;
  const runtimeOverrides: string[] = [];
  let workspace: string = process.cwd();
  let permissionMode: PermissionMode = "default";
  let defaultModel: string | undefined;
  let hostname: string | undefined;
  let port: number | undefined;
  let trustWorkspaceFlag = false;
  let registrySyncFlag = false;

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
      const isLegacy = (LEGACY_PERMISSION_MODES as readonly string[]).includes(next);
      if (!isCanonical && !isLegacy) {
        throw new Error(
          `[Gateway] Invalid permission mode "${next}". Valid modes: ${VALID_PERMISSION_MODES.join(", ")} (legacy aliases ${LEGACY_PERMISSION_MODES.join("/")} accepted with deprecation warning).`,
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

    if (arg === "--trust-workspace") {
      trustWorkspaceFlag = true;
      continue;
    }

    if (arg === "--registry-sync") {
      registrySyncFlag = true;
      continue;
    }

    throw new Error(
      `[Gateway] Unknown argument "${arg}". Supported args: --check, --runtime <id>, --runtimes <id1,id2,...>, --workspace <path>, --permission-mode <mode>, --default-model <id>, --port <port>, --hostname <host>, --trust-workspace, --registry-sync.`,
    );
  }

  const trustWorkspace = resolveTrustWorkspace(trustWorkspaceFlag, env);
  const registrySync = resolveRegistrySync(registrySyncFlag, env);

  return {
    check,
    runtimeOverrides,
    workspace,
    permissionMode,
    defaultModel,
    hostname,
    port,
    trustWorkspace,
    registrySync,
  };
}
