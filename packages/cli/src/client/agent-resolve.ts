/**
 * Resolve a running agent's A2A url by NAME from the shared registry, and
 * (optionally) wait until it is actually reachable before the TUI connects.
 *
 * This backs `agents-js client --agent <name> [--wait]`. It mirrors the
 * registry-lookup precedent in `send.ts` (which matches by `--harness`) but
 * matches by the agent's `name`, because the cockpit launch hands the TUI an
 * agent NAME and the runtime self-registers its (possibly ephemeral) url — so
 * the url is only knowable from the registry at connect time, never guessed.
 *
 * All I/O is injected (registry reader, health probe, clock, sleep) so the
 * resolution and readiness logic are unit-tested without disk, network, or real
 * time.
 */
import type { AgentRegistryRecord } from "@agents-js/a2a-client/node";

/** Thrown when no registered A2A agent matches the requested name. */
export class AgentNotRegisteredError extends Error {
  constructor(public readonly agent: string) {
    super(
      `[agents-js] no registered A2A agent named "${agent}". Launch it first, or pass --url/--card.`,
    );
    this.name = "AgentNotRegisteredError";
  }
}

/** Thrown when an agent does not become ready within the readiness budget. */
export class ReadinessTimeoutError extends Error {
  constructor(
    public readonly agent: string,
    public readonly lastStatus: string,
    public readonly elapsedMs: number,
  ) {
    super(
      `[agents-js] timed out after ${elapsedMs}ms waiting for agent "${agent}" to become ready (last: ${lastStatus})`,
    );
    this.name = "ReadinessTimeoutError";
  }
}

/** Find the A2A record matching `name` with a usable url, or `undefined`. */
function findA2AByName(
  records: readonly AgentRegistryRecord[],
  name: string,
): AgentRegistryRecord | undefined {
  return records.find(
    (r) => r.name === name && r.kind === "a2a" && typeof r.url === "string" && r.url.length > 0,
  );
}

/**
 * Resolve the live A2A base url for a registered agent by name (single read).
 * Throws {@link AgentNotRegisteredError} on a miss.
 */
export function resolveAgentUrl(records: readonly AgentRegistryRecord[], name: string): string {
  const match = findA2AByName(records, name);
  if (!match?.url) {
    throw new AgentNotRegisteredError(name);
  }
  return match.url;
}

export type LoadRegistryRecords = () => Promise<AgentRegistryRecord[]>;
/** Minimal fetch surface: only the response status is needed for a health probe. */
export type HealthProbe = (url: string) => Promise<{ status: number }>;

export interface WaitForAgentReadyOptions {
  agent: string;
  loadRecords: LoadRegistryRecords;
  /** Probe the record's `health_check_url` (falls back to the agent-card path). */
  probe: HealthProbe;
  /** Monotonic-enough clock in ms; the CLI injects `Date.now`. */
  now: () => number;
  /** Sleep between polls; the CLI injects real `setTimeout`. */
  sleep: (ms: number) => Promise<void>;
  /** Total budget before giving up. Default 30_000ms. */
  timeoutMs?: number;
  /** Initial poll interval; backs off exponentially, capped at 2_000ms. Default 500ms. */
  intervalMs?: number;
  /** Optional progress callback ("absent" → "health 503" → "ready"). */
  onStatus?: (status: string) => void;
}

/**
 * Poll the registry until the agent's record appears AND its health endpoint
 * returns 2xx, then return the resolved url. Throws {@link ReadinessTimeoutError}
 * if the budget elapses first. Eliminates the connect race where the TUI starts
 * before the runtime has bound + self-registered.
 */
export async function waitForAgentReady(opts: WaitForAgentReadyOptions): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const start = opts.now();
  let interval = opts.intervalMs ?? 500;
  let lastStatus = "absent";

  for (;;) {
    try {
      const match = findA2AByName(await opts.loadRecords(), opts.agent);
      if (match?.url) {
        const healthUrl = match.health_check_url ?? `${match.url}/.well-known/agent-card.json`;
        try {
          const { status } = await opts.probe(healthUrl);
          if (status >= 200 && status < 300) {
            opts.onStatus?.("ready");
            return match.url;
          }
          lastStatus = `health ${status}`;
        } catch {
          lastStatus = "health unreachable";
        }
      } else {
        lastStatus = "absent";
      }
    } catch {
      lastStatus = "registry read error";
    }

    opts.onStatus?.(lastStatus);
    const elapsed = opts.now() - start;
    if (elapsed >= timeoutMs) {
      throw new ReadinessTimeoutError(opts.agent, lastStatus, elapsed);
    }
    await opts.sleep(interval);
    interval = Math.min(interval * 2, 2_000);
  }
}
