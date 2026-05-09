import { z } from "zod";
import { ValidationError } from "./errors.ts";
import type { ValidationResult } from "./result.ts";
import { zodIssuesToValidationIssues } from "./zod-utils.ts";

/**
 * Wire schema for an A2A registry record served or accepted across the
 * peer-sync wire (`GET /.well-known/agents-js-registry.json` and
 * `POST` of the same payload).
 *
 * Peer sync is **A2A-only**: `kind` is locked to the literal `"a2a"`
 * and ACP launch fields (`command`, `args`, `env`, `workspaceFlag`)
 * are not declared on the schema at all. The schema is `.strip()`-mode
 * so any unknown key on a peer-supplied record (including those four)
 * is silently dropped on parse — a malicious peer cannot smuggle
 * launch material onto an A2A record, and a future code path that
 * accidentally attaches a key to an A2A in-memory record cannot leak
 * it through the served payload either.
 *
 * `.strip()` over `.strict()` gives forward compatibility: a peer that
 * adds a new optional structural field on a future protocol bump must
 * not have its records rejected outright; the unknown field just does
 * not survive into our merged view.
 *
 * This is intentionally a *strict subset* of the persistence-side
 * `AgentRegistryRecord` interface declared in
 * `@agents-js/a2a-client/registry.ts`. The on-disk schema covers both
 * `kind="a2a"` and `kind="acp"` records and is read/written from
 * disk-only call sites; the wire schema is what crosses the network.
 */
export const WireAgentRegistryRecordSchema = z
  .object({
    name: z.string().min(1),
    agent_id: z.string().min(1),
    kind: z.literal("a2a"),
    gateway_id: z.string().min(1),
    source: z.enum(["auto-reg", "manual", "sync"]),
    registered_at: z.string().min(1),
    actor_type: z.enum(["human", "machine"]).optional(),
    url: z.string().optional(),
    harness: z.string().optional(),
    last_synced_at: z.string().optional(),
    protocol_version: z.string().optional(),
    card_cache_refreshed_at: z.string().optional(),
    preferred_gateway_id: z.string().optional(),
    expires_at: z.string().optional(),
    health_check_url: z.string().optional(),
    description: z.string().optional(),
  })
  .strip();

/** Inferred TypeScript shape of a parsed wire record. */
export type WireAgentRegistryRecord = z.infer<typeof WireAgentRegistryRecordSchema>;

/**
 * Validate an arbitrary `unknown` against the wire schema and return a
 * canonical {@link ValidationResult}. Mirrors the result shape used by
 * `validateAguiEvent` / `validateA2uiMessage` so consumers get a
 * uniform error surface.
 */
export function validateWireAgentRegistryRecord(
  raw: unknown,
): ValidationResult<WireAgentRegistryRecord> {
  const parsed = WireAgentRegistryRecordSchema.safeParse(raw);
  if (parsed.success) {
    return { valid: true, value: parsed.data };
  }

  const issues = zodIssuesToValidationIssues(parsed.error);
  return {
    valid: false,
    error: new ValidationError("Invalid wire AgentRegistryRecord", {
      field: issues[0]?.path ?? "input",
      value: raw,
      issues,
    }),
  };
}
