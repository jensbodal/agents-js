import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { type ACPProcess, createErrorAwareReadable, ndJsonStream } from "@agents-js/acp";
import {
  type HostEnvPolicyInput,
  type ResolvedHostEnvPolicy,
  resolveHostEnvPolicy,
} from "./env-policy.ts";
import { Logger } from "./logger.ts";
import type { HostACPProcessOptions } from "./types/process-options.ts";

const processLogger = new Logger("session");

/**
 * Compute the deterministic sandbox HOME directory for a given workspace identity root.
 * The hash ensures each logical workspace gets its own isolated HOME without collisions.
 */
export function sandboxHomePath(workspaceRootPath: string): string {
  const hash = createHash("sha256").update(workspaceRootPath).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), "acp-sandbox", hash);
}

const _ensuredSandboxHomes = new Set<string>();
function ensureSandboxHome(workspaceRootPath: string): void {
  const sandboxHome = sandboxHomePath(workspaceRootPath);
  if (_ensuredSandboxHomes.has(sandboxHome)) return;
  mkdirSync(sandboxHome, { recursive: true });
  _ensuredSandboxHomes.add(sandboxHome);
}

/**
 * Merge a base PATH string with caller-supplied extra bin paths,
 * preserving order and removing empty / duplicate segments. Inlined
 * (rather than imported from a runtime-resolution package) so that
 * `@agents-js/acp-host` stays free of harness-catalog dependencies.
 */
function buildExtendedPath(
  basePath: string | undefined,
  extraBinPaths?: readonly string[],
): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  const append = (segment: string): void => {
    if (!segment || seen.has(segment)) return;
    seen.add(segment);
    merged.push(segment);
  };
  if (basePath) {
    for (const segment of basePath.split(":")) {
      append(segment);
    }
  }
  if (extraBinPaths) {
    for (const segment of extraBinPaths) {
      append(segment);
    }
  }
  return merged.join(":");
}

export interface BuildMinimalEnvInput {
  workspaceRootPath: string;
  extraEnv?: Record<string, string>;
  extraBinPaths?: readonly string[];
  allowRealHome?: boolean;
  envPolicy?: HostEnvPolicyInput;
}

export function buildMinimalEnv(input: BuildMinimalEnvInput): Record<string, string> {
  const { workspaceRootPath, extraEnv, extraBinPaths, allowRealHome, envPolicy } = input;
  const policy = resolveHostEnvPolicy(envPolicy);
  return buildMinimalEnvFromResolved({
    workspaceRootPath,
    extraEnv,
    extraBinPaths,
    allowRealHome,
    policy,
  });
}

function buildMinimalEnvFromResolved(args: {
  workspaceRootPath: string;
  extraEnv?: Record<string, string>;
  extraBinPaths?: readonly string[];
  allowRealHome?: boolean;
  policy: ResolvedHostEnvPolicy;
}): Record<string, string> {
  const { workspaceRootPath, extraEnv, extraBinPaths, allowRealHome, policy } = args;
  const env: Record<string, string> = {};

  for (const key of policy.inheritedEnvKeys) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // Secret keys reach the agent process but never terminal commands.
  for (const key of policy.agentSecretEnvKeys) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  // Extend PATH with caller-supplied bin directories for GUI-launched hosts
  // whose inherited PATH may omit user-local tool roots.
  env.PATH = buildExtendedPath(env.PATH, extraBinPaths);

  if (!allowRealHome) {
    const sandboxHome = sandboxHomePath(workspaceRootPath);
    env.HOME = sandboxHome;
  }
  env.ACP_REAL_HOME = process.env.HOME ?? "";
  env.ACP_WORKSPACE_ROOT = workspaceRootPath;

  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (!policy.forbiddenExtraEnvKeys.has(key)) {
        env[key] = value;
      }
    }
  }

  return env;
}

function hasWorkspaceFlag(args: readonly string[], workspaceFlag: string): boolean {
  return args.some((arg) => arg === workspaceFlag || arg.startsWith(`${workspaceFlag}=`));
}

/**
 */
export function createHostACPProcess(
  workspaceRootPath: string,
  options: HostACPProcessOptions = {},
): ACPProcess {
  if (!options.command) {
    throw new Error("[ACP] createHostACPProcess requires an explicit command");
  }
  const {
    args = [],
    command,
    env,
    sessionCwd = workspaceRootPath,
    workspaceFlag = "--directory",
    extraBinPaths,
    allowRealHome,
    envPolicy,
  } = options;

  if (!allowRealHome) {
    ensureSandboxHome(workspaceRootPath);
  }

  const spawnArgs = [...args];
  if (sessionCwd && workspaceFlag && !hasWorkspaceFlag(args, workspaceFlag)) {
    spawnArgs.push(workspaceFlag, sessionCwd);
  }

  // `detached: true` makes the spawned process a process-group leader on Unix,
  // which lets `kill()` below signal the whole group (child + grandchildren).
  // Without this, grandchildren (e.g. shells spawned by `gemini --acp`) get
  // reparented to init when the direct child exits and continue running —
  // silently draining API tokens.
  //
  // NOTE: `detached: true` on Unix normally makes the child survive the
  // parent's death unless `child.unref()` is called. We intentionally DO NOT
  // call `unref()` here: agents-js owns the child's lifetime and always kills
  // it explicitly via the returned `kill()` function, so keeping it `ref`-ed
  // preserves the existing "parent holds the event loop open" behavior.
  //
  // On Windows, `detached: true` opens a new console window (detached children
  // get their own console), so we gate this off platform.
  const isUnix = process.platform !== "win32";
  const child = spawn(command, spawnArgs, {
    cwd: sessionCwd,
    env: buildMinimalEnv({
      workspaceRootPath,
      extraEnv: env,
      extraBinPaths,
      allowRealHome,
      envPolicy,
    }),
    stdio: ["pipe", "pipe", "inherit"],
    detached: isUnix,
  });

  if (!child.stdin || !child.stdout) {
    throw new Error("[ACP] Failed to get stdin/stdout from spawned process");
  }

  // Wrap the stdout readable so spawn errors propagate as stream errors
  // instead of clean closes (which is what Readable.toWeb + ndJsonStream does).
  const rawReadable = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
  const errorAwareReadable = createErrorAwareReadable({
    reader: rawReadable.getReader(),
    child,
    command,
    onError: (msg) => processLogger.error(msg),
  });

  const stream = ndJsonStream(Writable.toWeb(child.stdin), errorAwareReadable);

  return {
    stream,
    process: child,
    kill: () => {
      // On Unix, `detached: true` put the child in its own process group
      // (pgid === child.pid). Sending SIGTERM to `-pid` signals every process
      // in that group, killing grandchildren spawned by the agent (e.g. shells
      // launched by `gemini --acp`).
      if (isUnix && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* process-group already dead */
        }
        return;
      }
      child.kill();
    },
  };
}
