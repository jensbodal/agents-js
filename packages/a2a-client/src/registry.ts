import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentCard } from "@a2a-js/sdk";
import { validateAgentCard } from "@agents-js/validation/a2a";
import { summarizeCapabilities } from "./target.ts";
import type { ResolvedAgentTarget } from "./types.ts";

/** Kind of agent transport — `a2a` entries are routable over HTTP A2A; `acp` entries describe a spawnable ACP harness. */
export type AgentKind = "a2a" | "acp";

/** Who or what is behind an agent. Governance classifier; distinct from transport `kind`. */
export type AgentActorType = "human" | "machine";

/** How a registry record got here on this gateway. */
export type AgentRegistrySource = "auto-reg" | "manual" | "sync";

/**
 * A registry entry describing a remote A2A agent reachable over HTTP.
 *
 * `A2AAgentEntry` is also the v1 dispatch primitive for parent→child
 * gateway federation when a `HarnessCapabilityEntry` carries
 * `source: "remote"`. See `docs/federation/v1-contract.md`.
 */
export interface A2AAgentEntry {
  kind: "a2a";
  name: string;
  url: string;
}

/** A registry entry describing a locally spawnable ACP harness. */
export interface ACPAgentEntry {
  kind: "acp";
  name: string;
  /** Harness identifier (e.g. `claude`, `opencode`). */
  harness: string;
  /** Optional override command; defaults are harness-specific. */
  command?: string;
  /** Optional arguments passed to the harness command. */
  args?: string[];
  /** Optional extra environment variables merged into the harness process env. */
  env?: Record<string, string>;
  /** Optional override for the workspace flag (e.g. `--directory`). */
  workspaceFlag?: string;
}

/** A single entry from the registry config file (discriminated on `kind`). */
export type AgentEntry = A2AAgentEntry | ACPAgentEntry;

/** Full v2 on-disk record shape. */
export interface AgentRegistryRecord {
  name: string;
  agent_id: string;
  kind: AgentKind;
  url?: string;
  harness?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  workspaceFlag?: string;
  actor_type?: AgentActorType;
  gateway_id: string;
  source: AgentRegistrySource;
  registered_at: string;
  last_synced_at?: string;
  protocol_version?: string;
  card_cache_refreshed_at?: string;
  /** Reserved for sync conflict resolution. */
  preferred_gateway_id?: string;
  expires_at?: string;
  health_check_url?: string;
  description?: string;
}

/** Shape of the JSON registry config file. */
interface RegistryConfig {
  version?: 2;
  agents: Record<string, AgentEntryInput>;
}

/** Raw per-agent shape accepted by the registry loader. `kind` defaults to `"a2a"` for backward compatibility. */
type AgentEntryInput =
  | { kind?: "a2a"; url: string }
  | {
      kind: "acp";
      harness: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      workspaceFlag?: string;
    };

/** Cached card with expiry timestamp. */
interface CachedCard {
  target: ResolvedAgentTarget;
  expiresAt: number;
}

/** Thrown when the registry config file cannot be read or parsed. */
export class AgentRegistryConfigError extends Error {
  override readonly cause: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "AgentRegistryConfigError";
    this.cause = options?.cause;
  }
}

/** Options for constructing an {@link AgentRegistry}. */
export interface AgentRegistryOptions {
  /** Path to the registry JSON file. Defaults to `~/.agents-js/registry.json`. */
  configPath?: string;
  /** Cache TTL in milliseconds. Defaults to 60 000 (1 minute). */
  cacheTtlMs?: number;
  /** Custom fetch implementation for testing. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Timeout in milliseconds for fetching an agent card. Defaults to 10 000 (10 seconds). */
  cardFetchTimeoutMs?: number;
}

const DEFAULT_CONFIG_PATH = join(homedir(), ".agents-js", "registry.json");
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_CARD_FETCH_TIMEOUT_MS = 10_000;
const WELL_KNOWN_CARD_PATH = "/.well-known/agent-card.json";

/** Normalize a raw registry entry to a discriminated {@link AgentEntry}. */
function normalizeEntry(name: string, raw: AgentEntryInput): AgentEntry {
  if (raw.kind === "acp") {
    return {
      kind: "acp",
      name,
      harness: raw.harness,
      ...(raw.command !== undefined ? { command: raw.command } : {}),
      ...(raw.args !== undefined ? { args: raw.args } : {}),
      ...(raw.env !== undefined ? { env: raw.env } : {}),
      ...(raw.workspaceFlag !== undefined ? { workspaceFlag: raw.workspaceFlag } : {}),
    };
  }
  return { kind: "a2a", name, url: raw.url };
}

/** Validate + normalize a raw entry. Throws {@link AgentRegistryConfigError} on shape violations. */
function parseEntry(configPath: string, name: string, entry: unknown): AgentEntryInput {
  if (typeof entry !== "object" || entry === null) {
    throw new AgentRegistryConfigError(`[a2a-client] Invalid registry config at ${configPath}`);
  }
  const record = entry as Record<string, unknown>;
  const kind = record.kind;
  if (kind === "acp") {
    const harness = record.harness;
    if (typeof harness !== "string" || harness.trim().length === 0) {
      throw new AgentRegistryConfigError(
        `[a2a-client] Invalid registry config at ${configPath}: agent "${name}" has kind "acp" but is missing a "harness" string`,
      );
    }
    const result: AgentEntryInput = { kind: "acp", harness };
    if (typeof record.command === "string") result.command = record.command;
    if (Array.isArray(record.args) && record.args.every((a) => typeof a === "string")) {
      result.args = record.args as string[];
    }
    if (
      typeof record.env === "object" &&
      record.env !== null &&
      Object.values(record.env as Record<string, unknown>).every((v) => typeof v === "string")
    ) {
      result.env = record.env as Record<string, string>;
    }
    if (typeof record.workspaceFlag === "string") result.workspaceFlag = record.workspaceFlag;
    return result;
  }
  if (kind !== undefined && kind !== "a2a") {
    throw new AgentRegistryConfigError(
      `[a2a-client] Invalid registry config at ${configPath}: agent "${name}" has unknown kind "${String(kind)}"`,
    );
  }
  const url = record.url;
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new AgentRegistryConfigError(
      `[a2a-client] Invalid registry config at ${configPath}: agent "${name}" is missing a "url" string`,
    );
  }
  return { kind: "a2a", url };
}

/**
 * Agent registry that resolves `@agent-name` references to A2A endpoints.
 *
 * Reads agent entries from a JSON config file and fetches + caches
 * agent cards from the resolved URLs. `kind: "acp"` entries are parsed
 * and returned by {@link AgentRegistry.list} but are NOT resolvable to
 * an A2A target — {@link AgentRegistry.resolve} returns null for them.
 */
export class AgentRegistry {
  private readonly configPath: string;
  private readonly cacheTtlMs: number;
  private readonly cardFetchTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, CachedCard>();
  private config: RegistryConfig | undefined;

  constructor(options: AgentRegistryOptions = {}) {
    this.configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.cardFetchTimeoutMs = options.cardFetchTimeoutMs ?? DEFAULT_CARD_FETCH_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Resolve an agent name to a {@link ResolvedAgentTarget}.
   * Returns `null` if the agent is not found in the registry config or
   * has `kind: "acp"` (ACP entries are not routable as A2A targets).
   * Throws if the agent card cannot be fetched or is invalid.
   */
  async resolve(name: string): Promise<ResolvedAgentTarget | null> {
    const config = await this.loadConfig();
    const raw = config.agents[name];
    if (!raw) {
      return null;
    }
    const entry = normalizeEntry(name, raw);
    if (entry.kind !== "a2a") {
      return null;
    }

    const cached = this.cache.get(name);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.target;
    }

    const target = await this.fetchCard(name, entry.url);
    this.cache.set(name, {
      target,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    return target;
  }

  /** List all agent entries from the registry config. */
  async list(): Promise<AgentEntry[]> {
    const config = await this.loadConfig();
    return Object.entries(config.agents).map(([name, entry]) => normalizeEntry(name, entry));
  }

  /** Clear the in-memory card cache and force a config reload on next access. */
  refresh(): void {
    this.cache.clear();
    this.config = undefined;
  }

  private async loadConfig(): Promise<RegistryConfig> {
    if (this.config) {
      return this.config;
    }

    let raw: string;
    try {
      raw = await readFile(this.configPath, "utf-8");
    } catch (error) {
      throw new AgentRegistryConfigError(
        `[a2a-client] Failed to read registry config at ${this.configPath}`,
        { cause: error },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new AgentRegistryConfigError(
        `[a2a-client] Invalid registry config at ${this.configPath}`,
        { cause: error },
      );
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("agents" in parsed) ||
      typeof (parsed as { agents: unknown }).agents !== "object" ||
      (parsed as { agents: unknown }).agents === null
    ) {
      throw new AgentRegistryConfigError(
        `[a2a-client] Invalid registry config at ${this.configPath}`,
      );
    }

    const rawAgents = (parsed as { agents: Record<string, unknown> }).agents;
    const validated: Record<string, AgentEntryInput> = {};
    for (const [name, entry] of Object.entries(rawAgents)) {
      validated[name] = parseEntry(this.configPath, name, entry);
    }

    this.config = { agents: validated };
    return this.config;
  }

  private async fetchCard(name: string, baseUrl: string): Promise<ResolvedAgentTarget> {
    const normalizedBase = baseUrl.replace(/\/+$/, "");
    const cardUrl = `${normalizedBase}${WELL_KNOWN_CARD_PATH}`;

    const response = await this.fetchImpl(cardUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(this.cardFetchTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(
        `[a2a-client] Failed to fetch agent card for "${name}" from ${cardUrl}: ${response.status} ${response.statusText}`,
      );
    }

    const body: unknown = await response.json();
    const card: AgentCard = validateAgentCard(body);

    return {
      baseUrl: normalizedBase,
      cardUrl,
      card,
      protocolVersion: card.supportedInterfaces[0]?.protocolVersion,
      capabilities: summarizeCapabilities(card),
    };
  }
}
