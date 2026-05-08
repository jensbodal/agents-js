import { isAbsolute, resolve } from "node:path";
import { isWithinWorkspace } from "@agents-js/policy";

export class CwdResolutionError extends Error {
  readonly code:
    | "invalid_workspace_root"
    | "relative_cwd"
    | "cwd_outside_workspace_root"
    | "workspace_root_rejected";

  constructor(code: CwdResolutionError["code"], message: string) {
    super(message);
    this.name = "CwdResolutionError";
    this.code = code;
  }
}

/** @hostSurface */
export interface ACPWorkspaceRootPolicy {
  resolveWorkspaceRoot(): Promise<string> | string;
  validateCwd?(cwd: string, workspaceRoot: string): Promise<boolean> | boolean;
}

export async function resolveSessionCwd(
  requestedCwd: string | undefined,
  workspacePolicy: ACPWorkspaceRootPolicy,
): Promise<string> {
  const rawWorkspaceRoot = await workspacePolicy.resolveWorkspaceRoot();
  if (!isAbsolute(rawWorkspaceRoot)) {
    throw new CwdResolutionError(
      "invalid_workspace_root",
      `Workspace root must be absolute. Received: ${rawWorkspaceRoot}`,
    );
  }
  const workspaceRoot = resolve(rawWorkspaceRoot);

  const candidate = requestedCwd ?? workspaceRoot;
  if (!isAbsolute(candidate)) {
    throw new CwdResolutionError(
      "relative_cwd",
      `Session cwd must be absolute. Received: ${candidate}`,
    );
  }

  const resolvedCandidate = resolve(candidate);
  if (!isWithinWorkspace(workspaceRoot, resolvedCandidate)) {
    throw new CwdResolutionError(
      "cwd_outside_workspace_root",
      `Session cwd must stay within the workspace root (${workspaceRoot}). Received: ${resolvedCandidate}`,
    );
  }

  const accepted = await workspacePolicy.validateCwd?.(resolvedCandidate, workspaceRoot);
  if (accepted === false) {
    throw new CwdResolutionError(
      "workspace_root_rejected",
      `Workspace policy rejected session cwd: ${resolvedCandidate}`,
    );
  }

  return resolvedCandidate;
}
