/**
 * v2 registry record shape: read-side migration, serialization, and
 * auto-registration write path.
 *
 * Extracted from node.ts into its own module so that startup.ts can import
 * these helpers without creating a three-way circular dependency
 * (startup.ts → node.ts → startup.ts through the re-export chain).
 *
 * Consumers should import from `@agents-js/a2a-client/node` — this module
 * is an internal implementation detail.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import type {
  AgentActorType,
  AgentKind,
  AgentRegistryRecord,
  AgentRegistrySource,
} from "./registry.ts";

export type { AgentRegistryRecord } from "./registry.ts";

const DEFAULT_SHARED_REGISTRY_PATH = join(homedir(), ".agents-js", "registry.json");

export function resolveSharedAgentRegistryPath(
  options: { configPath?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  // biome-ignore lint/style/noProcessEnv: node-only helper reads the shared registry override from the process environment by default.
  const env = options.env ?? process.env;
  return options.configPath ?? env.AGENTS_JS_REGISTRY ?? DEFAULT_SHARED_REGISTRY_PATH;
}

/** On-disk v2 file. `version` is absent on v1 files; synthesized on migration. */
interface RegistryFileV2 {
  version?: 2;
  agents: Record<string, Record<string, unknown>>;
}

/** Apply v1→v2 field synthesis to a single raw record. See spec §"Migration path". */
function migrateRecord(
  name: string,
  raw: Record<string, unknown>,
  defaults: { gatewayId: string; registeredAt: string },
): AgentRegistryRecord {
  const gatewayId =
    typeof raw.gateway_id === "string" && raw.gateway_id.length > 0
      ? raw.gateway_id
      : defaults.gatewayId;
  const agentId =
    typeof raw.agent_id === "string" && raw.agent_id.length > 0
      ? raw.agent_id
      : `${gatewayId}.${name}`;
  const source =
    raw.source === "auto-reg" || raw.source === "manual" || raw.source === "sync"
      ? raw.source
      : ("manual" as AgentRegistrySource);
  const registeredAt =
    typeof raw.registered_at === "string" && raw.registered_at.length > 0
      ? raw.registered_at
      : defaults.registeredAt;
  const actorType =
    raw.actor_type === "human" || raw.actor_type === "machine"
      ? raw.actor_type
      : ("machine" as AgentActorType);

  const kind: AgentKind = raw.kind === "acp" ? "acp" : "a2a";
  const record: AgentRegistryRecord = {
    name,
    agent_id: agentId,
    kind,
    actor_type: actorType,
    gateway_id: gatewayId,
    source,
    registered_at: registeredAt,
  };
  if (kind === "a2a" && typeof raw.url === "string") record.url = raw.url;
  if (kind === "acp") {
    if (typeof raw.harness === "string") record.harness = raw.harness;
    if (typeof raw.command === "string") record.command = raw.command;
    if (Array.isArray(raw.args) && raw.args.every((a) => typeof a === "string")) {
      record.args = raw.args as string[];
    }
    if (
      typeof raw.env === "object" &&
      raw.env !== null &&
      Object.values(raw.env as Record<string, unknown>).every((v) => typeof v === "string")
    ) {
      record.env = raw.env as Record<string, string>;
    }
    if (typeof raw.workspaceFlag === "string") record.workspaceFlag = raw.workspaceFlag;
  }
  if (typeof raw.last_synced_at === "string") record.last_synced_at = raw.last_synced_at;
  if (typeof raw.protocol_version === "string") record.protocol_version = raw.protocol_version;
  if (typeof raw.card_cache_refreshed_at === "string") {
    record.card_cache_refreshed_at = raw.card_cache_refreshed_at;
  }
  if (typeof raw.preferred_gateway_id === "string") {
    record.preferred_gateway_id = raw.preferred_gateway_id;
  }
  if (typeof raw.expires_at === "string") record.expires_at = raw.expires_at;
  if (typeof raw.health_check_url === "string") record.health_check_url = raw.health_check_url;
  if (typeof raw.description === "string") record.description = raw.description;
  return record;
}

/**
 * Read the v2 record shape, applying v1→v2 migration in-memory. Returns an
 * empty map when the file is absent or unparsable (fails open).
 */
export async function readAgentRegistryRecords(
  options: { configPath?: string } = {},
): Promise<AgentRegistryRecord[]> {
  const configPath = options.configPath ?? resolveSharedAgentRegistryPath();
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || !("agents" in parsed)) return [];
  const agents = (parsed as { agents?: unknown }).agents;
  if (typeof agents !== "object" || agents === null) return [];

  // v1 migration default: file mtime as registered_at watermark.
  let mtimeIso: string;
  try {
    const s = await stat(configPath);
    mtimeIso = s.mtime.toISOString();
  } catch {
    mtimeIso = new Date(0).toISOString();
  }
  const gatewayDefault = hostname();

  const out: AgentRegistryRecord[] = [];
  for (const [name, entry] of Object.entries(agents)) {
    if (typeof entry !== "object" || entry === null) continue;
    out.push(
      migrateRecord(name, entry as Record<string, unknown>, {
        gatewayId: gatewayDefault,
        registeredAt: mtimeIso,
      }),
    );
  }
  return out;
}

/**
 * Build the on-disk JSON payload from a record map, preserving v2 shape.
 * Exported so the Phase 2 sync module can write the merged state using the
 * same serializer autoRegister uses — one source of truth for the wire format.
 */
export function serializeRecords(records: Record<string, AgentRegistryRecord>): RegistryFileV2 {
  const agents: Record<string, Record<string, unknown>> = {};
  for (const [name, rec] of Object.entries(records)) {
    // Persist every field present on the record verbatim; the outer map key
    // matches rec.name but we persist both (spec example records include name).
    const row: Record<string, unknown> = {
      name: rec.name,
      agent_id: rec.agent_id,
      kind: rec.kind,
      gateway_id: rec.gateway_id,
      source: rec.source,
      registered_at: rec.registered_at,
    };
    if (rec.actor_type !== undefined) row.actor_type = rec.actor_type;
    if (rec.url !== undefined) row.url = rec.url;
    if (rec.harness !== undefined) row.harness = rec.harness;
    if (rec.command !== undefined) row.command = rec.command;
    if (rec.args !== undefined) row.args = rec.args;
    if (rec.env !== undefined) row.env = rec.env;
    if (rec.workspaceFlag !== undefined) row.workspaceFlag = rec.workspaceFlag;
    if (rec.last_synced_at !== undefined) row.last_synced_at = rec.last_synced_at;
    if (rec.protocol_version !== undefined) row.protocol_version = rec.protocol_version;
    if (rec.card_cache_refreshed_at !== undefined) {
      row.card_cache_refreshed_at = rec.card_cache_refreshed_at;
    }
    if (rec.preferred_gateway_id !== undefined) {
      row.preferred_gateway_id = rec.preferred_gateway_id;
    }
    if (rec.expires_at !== undefined) row.expires_at = rec.expires_at;
    if (rec.health_check_url !== undefined) row.health_check_url = rec.health_check_url;
    if (rec.description !== undefined) row.description = rec.description;
    agents[name] = row;
  }
  return { version: 2, agents };
}

/** Options shared by all {@link autoRegister} calls. */
export interface AutoRegisterOptionsBase {
  /** Local agent name. Unique within this gateway. */
  name: string;
  /** Override the registry path. Defaults to {@link resolveSharedAgentRegistryPath}. */
  configPath?: string;
  /** Override the gateway identifier. Defaults to `os.hostname()`. */
  gatewayId?: string;
  /** Governance classifier. Defaults to `"machine"`. */
  actorType?: AgentActorType;
  /** Mirrors AgentCard.protocolVersion. */
  protocolVersion?: string;
  /** Cached AgentCard description. */
  description?: string;
  /** When the cached AgentCard fields were last refreshed. ISO-8601 UTC. */
  cardCacheRefreshedAt?: string;
  /** Availability-probe URL for future Phase 2 liveness checks. */
  healthCheckUrl?: string;
  /** Override the registered_at timestamp. Defaults to `new Date().toISOString()`. */
  registeredAt?: string;
}

/** Transport-a2a auto-reg options. */
export interface AutoRegisterA2AOptions extends AutoRegisterOptionsBase {
  kind: "a2a";
  url: string;
}

/** Transport-acp auto-reg options. */
export interface AutoRegisterACPOptions extends AutoRegisterOptionsBase {
  kind: "acp";
  harness: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  workspaceFlag?: string;
}

export type AutoRegisterOptions = AutoRegisterA2AOptions | AutoRegisterACPOptions;

/**
 * Idempotent auto-registration. Writes a v2 record for `options.name`,
 * replacing any prior entry with the same name. Synthesizes provenance
 * (`gateway_id`, `source=auto-reg`, `registered_at`, `agent_id`).
 */
export async function autoRegister(options: AutoRegisterOptions): Promise<AgentRegistryRecord> {
  const configPath = options.configPath ?? resolveSharedAgentRegistryPath();
  const gatewayId = options.gatewayId ?? hostname();
  const registeredAt = options.registeredAt ?? new Date().toISOString();
  const actorType: AgentActorType = options.actorType ?? "machine";

  const record: AgentRegistryRecord = {
    name: options.name,
    agent_id: `${gatewayId}.${options.name}`,
    kind: options.kind,
    actor_type: actorType,
    gateway_id: gatewayId,
    source: "auto-reg",
    registered_at: registeredAt,
  };
  if (options.kind === "a2a") {
    record.url = options.url;
  } else {
    record.harness = options.harness;
    if (options.command !== undefined) record.command = options.command;
    if (options.args !== undefined) record.args = options.args;
    if (options.env !== undefined) record.env = options.env;
    if (options.workspaceFlag !== undefined) record.workspaceFlag = options.workspaceFlag;
  }
  if (options.protocolVersion !== undefined) record.protocol_version = options.protocolVersion;
  if (options.description !== undefined) record.description = options.description;
  if (options.cardCacheRefreshedAt !== undefined) {
    record.card_cache_refreshed_at = options.cardCacheRefreshedAt;
  }
  if (options.healthCheckUrl !== undefined) record.health_check_url = options.healthCheckUrl;

  const existing = await readAgentRegistryRecords({ configPath });
  const merged: Record<string, AgentRegistryRecord> = {};
  for (const r of existing) merged[r.name] = r;
  merged[options.name] = record;

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(serializeRecords(merged), null, 2)}\n`);
  return record;
}
