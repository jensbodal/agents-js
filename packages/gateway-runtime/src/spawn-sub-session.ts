/**
 * `spawnSubSession` — gateway-layer subagent-dispatch primitive.
 *
 * Bottom-of-the-stack for the SpawnAgent tool. This function owns the
 * "spin up a subagent ACP process, hand it a subtask, wait for the terminal
 * summary, clean up" mechanics. The tool-facing wrapper in `@agents-js/tools`
 * wraps it with provenance tagging, `TraceEmitter` parent/root threading, and
 * per-agent redaction.
 *
 * Current scope:
 *
 * - **Bounded mode only.** Detached mode + polling handle ships in a
 *   follow-on change.
 * - **Trial-agent harness only.** The in-repo isolation agent is the
 *   only harness registered as supported; explicit requests for any
 *   other harness return `status: "harness_unavailable"` without silent
 *   fallback. The caller asked for a specific execution boundary;
 *   silently running somewhere else would be lying about where the
 *   work ran.
 * - **No worktree isolation.** `hints.worktree_isolation` is accepted
 *   in the shape but currently ignored; subagents share the parent's
 *   working copy.
 * - **No cross-host spawning.** Subagent always runs on the same host
 *   as the parent.
 * - **Model hint ignored.** Harness-specific `hints.model` is accepted
 *   in the shape but not threaded through to trial-agent (it doesn't
 *   take a model flag). Shape preserved for future harnesses.
 *
 * Intentional non-goals for v1:
 *
 * - No receipt / commitReceipt token pattern. Ships when the inbox
 *   primitive lands with `commitReceipt(token, {integrated|aborted})`.
 * - No cost accounting populated (interface reserves the shape; v1
 *   always returns unpopulated because trial-agent doesn't report
 *   tokens/model/$).
 * - No self-spawn depth enforcement at this layer. Depth tracking is
 *   threaded through the `@agents-js/tools` wrapper via explicit
 *   `parent_session_id` — the gateway layer doesn't introspect the
 *   parent chain.
 */

import { randomUUID } from "node:crypto";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type SessionNotification,
  type Stream,
} from "@agentclientprotocol/sdk";
import { spawnACPAgent } from "@agents-js/acp";
import { resolveGatewayRuntime } from "./runtimes.ts";
import type {
  GatewayRuntimeId,
  ResolvedGatewayRuntime,
  RuntimeResolutionOptions,
} from "./runtimes-registry.ts";

/**
 * Harness ids supported by `spawnSubSession` v1. Expand this set as
 * harnesses land hardening gates for subagent spawning.
 */
export const SPAWN_SUB_SESSION_SUPPORTED_HARNESSES: readonly GatewayRuntimeId[] = ["trial"];

/** Default harness used when `hints.harness` is unspecified. */
export const SPAWN_SUB_SESSION_DEFAULT_HARNESS: GatewayRuntimeId = "trial";

/** Default subtask timeout (5 minutes). */
export const SPAWN_SUB_SESSION_DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Routing hints. All fields optional. `harness` is explicit opt-in to
 * a specific execution boundary; unset falls back to the default.
 * `worktree_isolation` / `model` are accepted in the shape for
 * forward-compatibility but ignored in v1.
 */
export interface SpawnSubSessionHints {
  /** Explicit harness name. Unset = default; unsupported = fail closed. */
  harness?: string;
  /** Working directory for the subagent session. Defaults to `process.cwd()`. */
  workspace_root?: string;
  /** Reserved for v1; currently ignored (accepted for forward-compat). */
  worktree_isolation?: boolean;
  /** Reserved for v1; currently ignored (accepted for forward-compat). */
  model?: string;
}

/**
 * Input to {@link spawnSubSession}. `parent_session_id` is carried so
 * downstream trace / audit surfaces can attribute the child to its
 * spawning session; this layer does not enforce depth limits on it.
 */
export interface SpawnSubSessionParams {
  parent_session_id: string;
  subtask: string;
  hints?: SpawnSubSessionHints;
  /** v1 supports only `"bounded"`. Other values fail closed. */
  mode: "bounded";
  timeout_ms?: number;
}

/**
 * Terminal status of a {@link spawnSubSession} call.
 *
 * - `completed` — subagent returned an `end_turn` stopReason within
 *   the timeout.
 * - `errored` — subagent returned a non-`end_turn` stopReason, or the
 *   ACP handshake / prompt threw.
 * - `timed_out` — timeout elapsed before terminal response.
 * - `harness_unavailable` — requested harness is not in the supported
 *   set, or its runtime resolution failed (binary missing, etc).
 */
export type SpawnSubSessionStatus = "completed" | "errored" | "timed_out" | "harness_unavailable";

/**
 * Result of a bounded-mode {@link spawnSubSession} call. `session_id`
 * is the ACP session id of the spawned child (empty string when the
 * call short-circuited before session creation, e.g. harness_unavailable).
 * `summary` is the concatenation of every `agent_message_chunk` text
 * notification observed during the subtask; on error / timeout it may
 * contain partial output emitted before the failure.
 */
export interface SpawnSubSessionResult {
  session_id: string;
  summary: string;
  status: SpawnSubSessionStatus;
  duration_ms: number;
  harness: string;
  error?: { code: string; message: string };
}

/**
 * Abstraction over `spawnACPAgent` for test injection. Shape matches
 * the imported function; tests substitute a fake that returns a
 * controlled `Stream` / `kill` handle.
 */
export type SpawnACPAgentFn = typeof spawnACPAgent;

/**
 * Runtime resolver shape. Factored out so tests can inject a resolver
 * that returns canned `ResolvedGatewayRuntime` values without touching
 * the filesystem.
 */
export type ResolveGatewayRuntimeFn = (
  runtimeId: string,
  options?: RuntimeResolutionOptions,
) => Promise<ResolvedGatewayRuntime>;

/**
 * Dependency injection seams. All optional; defaults wire production
 * behavior. Tests that don't supply these get real filesystem + real
 * subprocess spawn.
 */
export interface SpawnSubSessionOptions {
  /** Substitute ACP spawner. Defaults to `spawnACPAgent`. */
  spawnAgent?: SpawnACPAgentFn;
  /** Runtime resolver. Defaults to `resolveGatewayRuntime`. */
  resolveRuntime?: ResolveGatewayRuntimeFn;
  /** Time source for `duration_ms`. Defaults to `Date.now`. */
  now?: () => number;
  /** Options passed through to the runtime resolver. */
  resolverOptions?: RuntimeResolutionOptions;
}

/**
 * Spawn a bounded-mode subagent session, run the subtask, return the
 * terminal summary. See module-level docstring for v1 scope.
 *
 * Intentional invariant: cleanup runs on every path. The spawned child
 * process is killed via `acp.kill()` in a `finally` block, whether the
 * call returned success, threw, or timed out. Callers do not need to
 * manage the child's lifetime.
 *
 * The returned result is a pure value; side effects (child process
 * creation, termination) are internal.
 */
export async function spawnSubSession(
  params: SpawnSubSessionParams,
  options: SpawnSubSessionOptions = {},
): Promise<SpawnSubSessionResult> {
  if (params.mode !== "bounded") {
    return {
      session_id: "",
      summary: "",
      status: "errored",
      duration_ms: 0,
      harness: params.hints?.harness ?? SPAWN_SUB_SESSION_DEFAULT_HARNESS,
      error: {
        code: "gateway/unsupported-mode",
        message: `spawnSubSession v1 supports only mode="bounded"; got "${params.mode as string}".`,
      },
    };
  }

  const requestedHarness = params.hints?.harness;
  const harness = requestedHarness ?? SPAWN_SUB_SESSION_DEFAULT_HARNESS;

  if (!(SPAWN_SUB_SESSION_SUPPORTED_HARNESSES as readonly string[]).includes(harness)) {
    return {
      session_id: "",
      summary: "",
      status: "harness_unavailable",
      duration_ms: 0,
      harness,
      error: {
        code: "gateway/harness-unavailable",
        message: `Harness "${harness}" is not supported in spawnSubSession v1. Supported: ${SPAWN_SUB_SESSION_SUPPORTED_HARNESSES.join(", ")}.`,
      },
    };
  }

  const resolver = options.resolveRuntime ?? resolveGatewayRuntime;
  const spawner = options.spawnAgent ?? spawnACPAgent;
  const now = options.now ?? Date.now;
  const timeoutMs = params.timeout_ms ?? SPAWN_SUB_SESSION_DEFAULT_TIMEOUT_MS;
  const workspaceRoot = params.hints?.workspace_root ?? process.cwd();

  let runtime: ResolvedGatewayRuntime;
  try {
    runtime = await resolver(harness, options.resolverOptions);
  } catch (error) {
    return {
      session_id: "",
      summary: "",
      status: "harness_unavailable",
      duration_ms: 0,
      harness,
      error: toErrorShape(error, "gateway/harness-resolution-failed"),
    };
  }

  const startMs = now();
  const notifications: SessionNotification[] = [];

  // Spawn is inside the try so synchronous spawn errors (EACCES, ENOENT,
  // etc.) route through the standard errored path — and the finally
  // block is guarded against `acp` being undefined when spawn failed.
  type AcpHandle = { stream: Stream; kill: () => void };
  let acp: AcpHandle | undefined;
  let sessionId = "";
  try {
    acp = spawner({
      command: runtime.acp.command,
      args: runtime.acp.args ?? [],
      env: runtime.acp.env,
    });

    const connection = new ClientSideConnection(
      () => createSubSessionClientHandlers(notifications),
      acp.stream,
    );

    // The timeout budget covers the FULL subagent lifecycle — handshake
    // (initialize + newSession) plus the prompt — in one race. A hung-
    // but-alive handshake would otherwise escape the timeout (the race
    // only watches the last await). Rolling it all together also gives
    // callers a single meaningful guarantee: "spawnSubSession returns
    // within timeout_ms or I know it was canceled."
    const promptResp = await raceWithTimeout(
      (async () => {
        await connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const newSession = await connection.newSession({
          cwd: workspaceRoot,
          mcpServers: [],
        });
        sessionId = newSession.sessionId;
        return connection.prompt({
          sessionId,
          prompt: [{ type: "text", text: params.subtask }],
        });
      })(),
      timeoutMs,
      () => new SpawnSubSessionTimeoutError(timeoutMs),
    );
    const summary = extractSummary(notifications);
    const durationMs = now() - startMs;
    const status: SpawnSubSessionStatus =
      promptResp.stopReason === "end_turn" ? "completed" : "errored";

    const result: SpawnSubSessionResult = {
      session_id: sessionId,
      summary,
      status,
      duration_ms: durationMs,
      harness,
    };
    if (status === "errored") {
      result.error = {
        code: "gateway/non-end-turn",
        message: `Subagent terminated with stopReason="${String(promptResp.stopReason)}".`,
      };
    }
    return result;
  } catch (error) {
    const durationMs = now() - startMs;
    const timedOut = error instanceof SpawnSubSessionTimeoutError;
    return {
      session_id: sessionId,
      summary: extractSummary(notifications),
      status: timedOut ? "timed_out" : "errored",
      duration_ms: durationMs,
      harness,
      error: toErrorShape(error, timedOut ? "gateway/timeout" : "gateway/acp-error"),
    };
  } finally {
    // `kill()` can throw (bad subprocess state, already-terminated,
    // SIGKILL racing a zombied child). Swallow so the kill exception
    // never shadows an in-flight error that the caller actually needs
    // to see. Errors from the spawner / ACP layer remain visible via
    // the main try/catch; kill failures are observability-only and are
    // intentionally suppressed here.
    if (acp !== undefined) {
      try {
        acp.kill();
      } catch {
        /* intentional: see comment above */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Sentinel error used to disambiguate timeout vs ACP-layer error in
 * the catch block. Exposed for tests that want to assert on it.
 */
export class SpawnSubSessionTimeoutError extends Error {
  readonly code = "gateway/timeout";
  readonly timeout_ms: number;

  constructor(timeoutMs: number) {
    super(`spawnSubSession exceeded ${timeoutMs}ms timeout`);
    this.name = "SpawnSubSessionTimeoutError";
    this.timeout_ms = timeoutMs;
  }
}

/**
 * Race a promise against a timeout. Used for bounded-mode enforcement.
 * The timer is `.unref()`'d so a test harness that hits the timeout
 * doesn't hold Bun's event loop open.
 */
async function raceWithTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  makeError: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(makeError()), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([work, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Build the client-side ACP handlers for the subagent connection.
 *
 * v1 rejects every file / terminal / permission request from the
 * child. Subagents in scope are local + read-only; any request that
 * would need host cooperation is a bug. Tightening to permissive
 * handlers for richer subagents is a follow-on when needed.
 */
function createSubSessionClientHandlers(collector: SessionNotification[]) {
  const rejectUnsupported = (what: string) =>
    Promise.reject(new Error(`spawnSubSession v1: child requested ${what}; not supported`));
  return {
    async sessionUpdate(update: SessionNotification) {
      collector.push(update);
    },
    async requestPermission() {
      return { outcome: { outcome: "cancelled" as const } };
    },
    writeTextFile: () => rejectUnsupported("writeTextFile"),
    readTextFile: () => rejectUnsupported("readTextFile"),
    createTerminal: () => rejectUnsupported("createTerminal"),
    async killTerminal() {
      return;
    },
    async releaseTerminal() {
      return;
    },
    terminalOutput: () => rejectUnsupported("terminalOutput"),
    waitForTerminalExit: () => rejectUnsupported("waitForTerminalExit"),
  };
}

/**
 * Collect every `agent_message_chunk` text payload into a single
 * concatenated string. ACP spec allows a prompt's terminal response
 * to arrive as multiple chunks; this flattens them for the caller.
 */
function extractSummary(notifications: SessionNotification[]): string {
  const parts: string[] = [];
  for (const notification of notifications) {
    const update = notification.update;
    if (update?.sessionUpdate !== "agent_message_chunk") {
      continue;
    }
    const content = update.content;
    if (content?.type === "text" && typeof content.text === "string") {
      parts.push(content.text);
    }
  }
  return parts.join("");
}

/** Coerce an arbitrary thrown value into the schema-style error shape. */
function toErrorShape(value: unknown, fallbackCode: string): { code: string; message: string } {
  if (value instanceof SpawnSubSessionTimeoutError) {
    return { code: value.code, message: value.message };
  }
  if (value instanceof Error) {
    const code = (value as Error & { code?: string }).code ?? fallbackCode;
    return { code, message: value.message };
  }
  return { code: fallbackCode, message: String(value) };
}

/**
 * Generate a stable-looking session id for callers that spawn multiple
 * children and want local ordering even when the gateway's own
 * session_id isn't yet assigned (e.g. when a harness_unavailable
 * short-circuits before newSession). Exposed primarily for test
 * determinism and for callers building audit records; normal callers
 * read `result.session_id` after the call returns.
 */
export function generateSpawnCorrelationId(): string {
  return randomUUID();
}
