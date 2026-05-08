import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { CLIENT_METHODS, ndJsonStream, RequestError, type Stream } from "@agentclientprotocol/sdk";
import { createErrorAwareReadable } from "./stream-utils.ts";

export interface ACPProcessOptions {
  /** Command to spawn (default: "opencode") */
  command?: string;
  /** Arguments to the command (default: ["acp"]) */
  args?: string[];
  /** Extra environment variables */
  env?: Record<string, string>;
  /**
   * Optional spawn-env whitelist. When provided, only the listed keys
   * from `process.env` are inherited into the spawned ACP child;
   * everything else is dropped. The caller's `env` overrides are
   * applied on top of the whitelisted set.
   *
   * **When omitted, the spawned child inherits the full `process.env`**
   * — convenient for low-level / test callers but a real leak surface
   * for production gateways. The published `agents-js serve` command
   * always supplies this whitelist (computed from the resolved runtime's
   * `authEnvKeys` plus the project's standard inherited-env defaults)
   * so credentials never reach a runtime that did not declare them.
   *
   * Format: a flat array of env-var names (e.g. `["PATH", "HOME",
   * "ANTHROPIC_API_KEY"]`). Order is irrelevant; duplicates are
   * harmless.
   */
  inheritedEnvKeys?: readonly string[];
}

export interface ACPProcess {
  /** The ndJSON stream for ACP communication */
  stream: Stream;
  /** The underlying child process */
  process: ChildProcess;
  /** Kill the child process */
  kill(): void;
}

/**
 * Build the env map for the spawned child. When `inheritedEnvKeys` is
 * supplied, parent env is filtered to those keys (everything else is
 * dropped before overrides are layered on); otherwise the full
 * `process.env` is inherited (legacy behavior, kept for back-compat).
 *
 * Exported for unit testing — the regression we want to lock down is
 * "no key beyond the whitelist + caller-supplied overrides ever
 * reaches the spawned child", which is much easier to test against
 * this pure helper than against `spawn()` itself.
 */
export function buildSpawnEnv(
  parentEnv: NodeJS.ProcessEnv,
  options: {
    env?: Record<string, string>;
    inheritedEnvKeys?: readonly string[];
  },
): NodeJS.ProcessEnv {
  if (options.inheritedEnvKeys === undefined) {
    return { ...parentEnv, ...options.env };
  }
  const filtered: Record<string, string> = {};
  for (const key of options.inheritedEnvKeys) {
    const value = parentEnv[key];
    if (typeof value === "string") {
      filtered[key] = value;
    }
  }
  return { ...filtered, ...options.env };
}

/**
 * Spawn an ACP agent as a subprocess and create an ndJSON stream for communication.
 *
 * @hostSurface
 * @hostProcess
 */
export function spawnACPAgent(options: ACPProcessOptions = {}): ACPProcess {
  const { command = "opencode", args = ["acp"], env, inheritedEnvKeys } = options;

  // `detached: true` makes the spawned process a process-group leader on Unix,
  // which lets `kill()` below signal the whole group (child + grandchildren).
  // Without this, grandchildren (e.g. shells spawned by the agent) get
  // reparented to init when the direct child exits and continue running —
  // silently draining API tokens. See createHostACPProcess for the same fix.
  //
  // NOTE: `detached: true` on Unix normally makes the child survive the
  // parent's death unless `child.unref()` is called. We intentionally DO NOT
  // call `unref()` here: the caller owns the child's lifetime and kills it
  // explicitly via the returned `kill()` function, so keeping it `ref`-ed
  // preserves the existing "parent holds the event loop open" behavior.
  //
  // On Windows, `detached: true` opens a new console window (detached children
  // get their own console), so we gate this off platform.
  const isUnix = process.platform !== "win32";
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: buildSpawnEnv(process.env, { env, inheritedEnvKeys }),
    detached: isUnix,
  });

  if (!child.stdin || !child.stdout) {
    throw new Error("[ACP] Failed to get stdin/stdout from spawned process");
  }

  // Build the ndJSON stream from the raw stdio pipes.
  // ndJsonStream's internal TransformStream swallows errors from the input
  // readable (converting them to clean closes), so we wrap the *output*
  // readable to surface spawn/exit errors to consumers.
  const rawStream = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
  );

  const errorAwareReadable = createErrorAwareReadable({
    reader: rawStream.readable.getReader(),
    child,
    command,
    yieldOnDone: true,
  });

  const stream: Stream = {
    writable: rawStream.writable,
    readable: errorAwareReadable as ReadableStream<never>,
  };

  return {
    stream,
    process: child,
    kill: () => {
      // On Unix, `detached: true` put the child in its own process group
      // (pgid === child.pid). Sending SIGTERM to `-pid` signals every process
      // in that group, killing grandchildren spawned by the agent.
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

export type { Stream };
// `ClientSideConnection`, `ndJsonStream`, and `PROTOCOL_VERSION` are
// re-exported from `host-surface-sdk.ts` so the `@hostSurface` tag stays
// next to them without colliding with biome's organize-exports. Internal
// callers still import them via the `import` block at the top of this
// file.
export { CLIENT_METHODS, RequestError };
