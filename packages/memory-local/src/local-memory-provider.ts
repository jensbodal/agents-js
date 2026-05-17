import type {
  DeleteMemoryInput,
  MemoryActor,
  MemoryProvider,
  MemoryRecord,
  MemoryScope,
  ProviderCapabilities,
  SaveMemoryInput,
  UpdateMemoryInput,
} from "@agents-js/memory";
import { MemoryAclError, MemoryRevisionConflictError } from "@agents-js/memory";
import { cloneRecord } from "./clone.ts";
import type { MemoryPolicyGate, MemoryPolicyOp } from "./policy-gate.ts";
import { noopPolicyGate } from "./policy-gate.ts";
import type { Storage, StoredRecord } from "./storage.ts";

export interface LocalMemoryProviderOptions {
  /** Backing storage seam. The bundled `SqliteStorage` is the default. */
  storage: Storage;
  /** Optional policy hook. Defaults to {@link noopPolicyGate}. */
  policyGate?: MemoryPolicyGate;
  /** Override clock for deterministic tests. Returns ms since epoch. */
  now?: () => number;
  /** Override id generator for deterministic tests. */
  newId?: () => string;
}

/**
 * Local, single-process `MemoryProvider`. Orchestrates the policy-gate
 * seam, idempotency lookup, creator-only ACL, and optimistic-concurrency
 * checks on top of an injected `Storage` backend (typically
 * `SqliteStorage`).
 */
export class LocalMemoryProvider implements MemoryProvider {
  protected readonly storage: Storage;
  protected readonly policyGate: MemoryPolicyGate;
  protected readonly now: () => number;
  protected readonly newId: () => string;

  constructor(opts: LocalMemoryProviderOptions) {
    this.storage = opts.storage;
    this.policyGate = opts.policyGate ?? noopPolicyGate;
    this.now = opts.now ?? (() => Date.now());
    this.newId = opts.newId ?? defaultIdGen();
  }

  capabilities(): ProviderCapabilities {
    return { idempotency: true, revisions: true, acl: true };
  }

  async saveMemory(actor: MemoryActor, input: SaveMemoryInput): Promise<MemoryRecord> {
    if (input.idempotencyKey !== undefined) {
      const existing = await this.storage.findByIdempotency(
        actor.kind,
        actor.actorId,
        input.idempotencyKey,
      );
      if (existing !== undefined) {
        return toPublicRecord(existing);
      }
    }

    await this.checkPolicy("save", actor, input.scope, input.type, input.metadata);

    const ts = this.now();
    const record: StoredRecord = {
      id: this.newId(),
      scope: cloneRecord(input.scope),
      type: input.type,
      content: input.content,
      metadata: cloneRecord(input.metadata ?? {}),
      createdAtMs: ts,
      updatedAtMs: ts,
      revision: "1",
      creator: { kind: actor.kind, actorId: actor.actorId },
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    };
    const persisted = await this.storage.insertRecord(record);
    return toPublicRecord(persisted);
  }

  async updateMemory(actor: MemoryActor, input: UpdateMemoryInput): Promise<MemoryRecord> {
    const existing = await this.storage.getRecord(input.id);
    if (existing === undefined) {
      throw new Error(`No memory record with id ${input.id}`);
    }

    await this.checkPolicy("update", actor, existing.scope, existing.type, input.metadata);
    this.requireCreator(actor, existing);

    const result = await this.storage.updateRecord(
      input.id,
      { content: input.content, metadata: input.metadata },
      input.expectedRevision,
    );

    if (!result.ok) {
      throw new MemoryRevisionConflictError(input.id, result.current.revision ?? "");
    }
    return toPublicRecord(result.record);
  }

  async deleteMemory(actor: MemoryActor, input: DeleteMemoryInput): Promise<void> {
    const existing = await this.storage.getRecord(input.id);
    if (existing === undefined) {
      // Match `InMemoryProvider`: delete-on-missing is a silent no-op.
      return;
    }

    await this.checkPolicy("delete", actor, existing.scope, existing.type, input.policy);
    this.requireCreator(actor, existing);

    await this.storage.deleteRecord(input.id);
  }

  /**
   * Pre-storage policy gate hook. Lifts a non-`allow` decision (deny or,
   * in v1, ask) into a `MemoryAclError` before any storage write occurs.
   * For update/delete the orchestrator pre-loads the existing record so
   * the gate observes the real scope/type rather than a placeholder.
   */
  protected async checkPolicy(
    op: MemoryPolicyOp,
    actor: MemoryActor,
    scope: MemoryScope,
    type: string,
    metadata: Record<string, unknown> | undefined,
  ): Promise<void> {
    const result = await this.policyGate.evaluate({ op, actor, scope, type, metadata });
    if (result.decision !== "allow") throw new MemoryAclError(actor, scope);
  }

  /**
   * Built-in creator-only ACL. Mirrors `InMemoryProvider` — only the
   * actor that called `saveMemory` may update or delete the record.
   * Runs AFTER the policy gate so a custom gate can also deny, but
   * stays in force even when the gate is the default noop.
   */
  protected requireCreator(actor: MemoryActor, record: StoredRecord): void {
    if (actor.kind === record.creator.kind && actor.actorId === record.creator.actorId) {
      return;
    }
    throw new MemoryAclError(actor, record.scope);
  }
}

function toPublicRecord(stored: StoredRecord): MemoryRecord {
  const { creator: _creator, idempotencyKey: _idem, ...rest } = stored;
  return {
    ...rest,
    scope: cloneRecord(rest.scope),
    metadata: cloneRecord(rest.metadata),
  };
}

function defaultIdGen(): () => string {
  let counter = 0;
  return () => `mem_${Date.now().toString(36)}_${(++counter).toString(36)}`;
}
