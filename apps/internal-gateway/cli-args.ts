import type { PermissionMode } from "@agents-js/acp-host";
import { parseGatewayPort } from "./discovery.ts";

export const VALID_PERMISSION_MODES: PermissionMode[] = ["ask", "yolo", "plan", "hub"];

export interface GatewayCliArgs {
  check: boolean;
  defaultModel?: string;
  hostname?: string;
  permissionMode: PermissionMode;
  port?: number;
  runtimeOverride?: string;
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

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv): GatewayCliArgs {
  let check = false;
  let runtimeOverride: string | undefined;
  let workspace: string = process.cwd();
  let permissionMode: PermissionMode = "ask";
  let defaultModel: string | undefined;
  let hostname: string | undefined;
  let port: number | undefined;
  let trustWorkspaceFlag = false;

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
      runtimeOverride = next;
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
      if (!VALID_PERMISSION_MODES.includes(next as PermissionMode)) {
        throw new Error(
          `[Gateway] Invalid permission mode "${next}". Valid modes: ${VALID_PERMISSION_MODES.join(", ")}`,
        );
      }
      permissionMode = next as PermissionMode;
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

    throw new Error(
      `[Gateway] Unknown argument "${arg}". Supported args: --check, --runtime <id>, --workspace <path>, --permission-mode <mode>, --default-model <id>, --port <port>, --hostname <host>, --trust-workspace.`,
    );
  }

  const trustWorkspace = resolveTrustWorkspace(trustWorkspaceFlag, env);

  return {
    check,
    runtimeOverride,
    workspace,
    permissionMode,
    defaultModel,
    hostname,
    port,
    trustWorkspace,
  };
}
