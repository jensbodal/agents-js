import type { PermissionRule } from "@agents-js/policy/permission-types";

/**
 * Persistence layer for permission rules.
 * Session-scoped rules are held in memory.
 * Persistent rules are saved via a host-provided callback.
 */
export class PermissionStore {
  private saveCallback: ((rules: PermissionRule[]) => Promise<void>) | null = null;
  private rules: PermissionRule[] = [];

  /**
   * Initialize the store with a save callback and previously persisted rules.
   */
  init(
    persistedRules: PermissionRule[],
    saveCallback: (rules: PermissionRule[]) => Promise<void>,
  ): void {
    this.rules = [...persistedRules];
    this.saveCallback = saveCallback;
  }

  getRules(): PermissionRule[] {
    return [...this.rules];
  }

  addRule(rule: PermissionRule): void {
    this.rules.push(rule);
    if (rule.lifetime === "persistent") {
      this.persist();
    }
  }

  removeRule(ruleId: string): boolean {
    const idx = this.rules.findIndex((r) => r.id === ruleId);
    if (idx < 0) return false;
    const removed = this.rules.splice(idx, 1)[0];
    if (!removed) return false;
    if (removed.lifetime === "persistent") {
      this.persist();
    }
    return true;
  }

  clearAll(): void {
    this.rules = [];
    this.persist();
  }

  clearSessionRules(): void {
    const hadPersistent = this.rules.some((r) => r.lifetime === "persistent");
    this.rules = this.rules.filter((r) => r.lifetime === "persistent");
    if (hadPersistent) {
      // No need to persist -- persistent rules unchanged
    }
  }

  /** Get only the persistent rules (for saving to host data) */
  getPersistentRules(): PermissionRule[] {
    return this.rules.filter((r) => r.lifetime === "persistent");
  }

  persistRules(): void {
    this.persist();
  }

  private persist(): void {
    const persistent = this.getPersistentRules();
    this.saveCallback?.(persistent).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[PermissionStore] Failed to persist rules: ${message}`);
    });
  }
}
