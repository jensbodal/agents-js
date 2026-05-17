/**
 * Where a memory entry is visible. Caller resolves identity before calling
 * — there is no `"self"` sentinel. The provider treats the scope as opaque
 * for storage and as input to ACL when ACL is supported.
 */
export type MemoryScope =
  | { kind: "agent"; agentId: string }
  | { kind: "room"; roomId: string }
  | { kind: "global" };

/**
 * Open enum. Recommended initial subset; providers MAY accept additional
 * type strings, but consumers SHOULD pick from this list when possible
 * so cross-provider queries (via fetchContext) can filter consistently.
 */
export type MemoryType = "user" | "feedback" | "project" | "reference" | "learning" | (string & {});

/**
 * Caller principal. Every primitive operation carries one. The provider
 * uses this to enforce scope ACL (if it implements ACL) and to populate
 * record provenance.
 *
 * Future versions MAY add more principal kinds (e.g. `scheduled-job`).
 */
export interface MemoryActor {
  kind: "agent" | "human" | "service";
  actorId: string;
}

export interface SaveMemoryInput {
  scope: MemoryScope;
  type: MemoryType;
  content: string;
  /** Provider-opaque metadata; persisted alongside content. */
  metadata?: Record<string, unknown>;
  /**
   * Optional caller-supplied idempotency key. Providers MAY honor this to
   * dedupe rapid same-key writes; provider MUST surface idempotency support
   * via {@link ProviderCapabilities}. Absent the key, each call creates a
   * new record.
   */
  idempotencyKey?: string;
}

export interface UpdateMemoryInput {
  id: string;
  /**
   * Replaces existing content if provided. If both `content` and
   * `metadata` are absent (no-op update), providers MUST return the
   * existing record unchanged — no `revision` bump, no `updatedAtMs`
   * advance. This lets callers use `updateMemory(actor, { id })` as
   * a cheap authorization-gated read-back without invalidating other
   * holders' `expectedRevision` tokens.
   */
  content?: string;
  /**
   * Replaces existing metadata if provided (full replace, not merge).
   * Read-modify-write is required for single-field updates in v1.
   */
  metadata?: Record<string, unknown>;
  /**
   * Optional optimistic-concurrency hint. When provided, providers with
   * `capabilities.revisions === true` MUST reject the update if the
   * current `revision` differs (raises `MemoryRevisionConflictError`).
   * Providers without revision support MUST ignore this field.
   */
  expectedRevision?: string;
}

export interface DeleteMemoryInput {
  id: string;
  /**
   * Policy-related context passed to the provider's policy gate but
   * NOT persisted. Scoped naming (vs. generic `metadata`) keeps the
   * field intent-narrow so destructive-consent context and future
   * policy-family extensions (signed consent tokens, cross-host
   * attestation, etc.) live under one namespace without grab-bagging
   * unrelated request-tracing or telemetry concerns.
   *
   * `policy.consentToken` is the convention destructive policy gates
   * may consult; the validator is owned by the gate implementation.
   */
  policy?: {
    consentToken?: string;
    [extension: string]: unknown;
  };
}

/**
 * Canonical record shape returned by save/update. Providers MUST populate
 * all required fields; optional fields are present iff the provider's
 * capabilities advertise support.
 */
export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  type: MemoryType;
  content: string;
  metadata: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
  /** Present iff `capabilities.revisions === true`. */
  revision?: string;
}

/**
 * Capability discovery — consumers can probe provider behavior without
 * hard-coding backend assumptions. Providers MUST return this from
 * `capabilities()`.
 */
export interface ProviderCapabilities {
  /** Provider honors `idempotencyKey` on save. */
  idempotency: boolean;
  /** Provider returns `revision` on records and honors `expectedRevision`. */
  revisions: boolean;
  /** Provider enforces ACL on `MemoryActor` × `MemoryScope` pairs. */
  acl: boolean;
}
