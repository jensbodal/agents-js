/**
 * Shared agent registry loader for the gateway.
 *
 * Both the @@dispatch executor and @mention middleware need to resolve
 * agent names to A2A URLs. This module provides a single implementation.
 */
import { readFileSync } from "node:fs";
import type { AgentEntry } from "@agents-js/a2a-client/node";
import { resolveSharedAgentRegistryPath } from "@agents-js/a2a-client/node";
import { normalizeAgentName } from "@agents-js/acp-host";

/** Name-keyed agent map used by the gateway's dispatch path. */
export type AgentRegistryMap = Record<string, AgentEntry>;

/**
 * Build an ACP-kind registry entry from a raw record.
 *
 * Validation contract: only the required `harness` field is enforced (must be
 * a non-empty string; otherwise we return null and the caller skips the
 * entry). Optional fields (`command`, `args`, `env`, `workspaceFlag`) are
 * included when present *and* well-typed; malformed optional fields are
 * silently dropped without rejecting the record. Callers should treat the
 * returned shape as best-effort beyond the required field.
 */
function buildAcpEntry(name: string, record: Record<string, unknown>): AgentEntry | null {
  if (typeof record.harness !== "string" || record.harness.trim().length === 0) {
    return null;
  }
  return {
    kind: "acp",
    name,
    harness: record.harness,
    ...(typeof record.command === "string" ? { command: record.command } : {}),
    ...(Array.isArray(record.args) && record.args.every((a) => typeof a === "string")
      ? { args: record.args as string[] }
      : {}),
    ...(typeof record.env === "object" &&
    record.env !== null &&
    Object.values(record.env as Record<string, unknown>).every((v) => typeof v === "string")
      ? { env: record.env as Record<string, string> }
      : {}),
    ...(typeof record.workspaceFlag === "string" ? { workspaceFlag: record.workspaceFlag } : {}),
  };
}

/**
 * Build an A2A-kind registry entry from a raw record.
 *
 * Validation contract: only the required `url` field is enforced (must be a
 * non-empty string; otherwise we return null and the caller skips the
 * entry). A2A entries carry no optional fields beyond `kind` / `name` /
 * `url`, so the contract here is simpler than `buildAcpEntry`'s.
 */
function buildA2aEntry(name: string, record: Record<string, unknown>): AgentEntry | null {
  if (typeof record.url !== "string" || record.url.trim().length === 0) {
    return null;
  }
  return { kind: "a2a", name, url: record.url };
}

/**
 * Load the agent registry from disk.
 *
 * Reads from `AGENTS_JS_REGISTRY` env var or `~/.agents-js/registry.json`.
 * Returns an empty map on any read/parse error (this silent fallback is
 * intentional: a missing or malformed registry must not crash the gateway
 * at startup).
 *
 * Entries missing an explicit `kind` default to `"a2a"` for backward
 * compatibility. `kind: "acp"` entries are preserved so upstream
 * dispatch code can log and reject them cleanly rather than crashing on
 * silent `.url` access.
 */
export function loadRegistryFromDisk(): AgentRegistryMap {
  const registryPath = resolveSharedAgentRegistryPath();

  try {
    const raw = readFileSync(registryPath, "utf-8");
    const parsed = JSON.parse(raw) as { agents?: Record<string, unknown> };
    const agents = parsed.agents ?? {};
    const out: AgentRegistryMap = {};
    for (const [rawName, entry] of Object.entries(agents)) {
      if (typeof entry !== "object" || entry === null) continue;
      // Apply the same ZWSP / default-ignorable stripping we use at the ACP
      // session-controller `agentInfo.name` ingress. Registry keys are
      // user-typed strings and can legitimately carry the same upstream
      // formatting artifacts (copy-paste BOMs, oh-my-openagent sort prefix,
      // bidi overrides, etc.). Normalize here so lookups by `normalizeAgentName`
      // downstream find the entry, and so the cleaned name flows consistently
      // through config.agentConfig.name into session controller state.
      const { name } = normalizeAgentName(rawName);
      if (name.length === 0) continue;
      const record = entry as Record<string, unknown>;
      const built =
        record.kind === "acp" ? buildAcpEntry(name, record) : buildA2aEntry(name, record);
      if (built) {
        out[name] = built;
      }
    }
    return out;
  } catch {
    return {};
  }
}
