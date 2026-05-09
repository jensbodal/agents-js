/**
 * Stateful permission engine wrapping @agents-js/policy stateless functions.
 *
 * Owns the in-memory rule array and delegates evaluation/creation to the
 * pure functions from the policy package. Hosts instantiate this class
 * and pass it to the session controller via StartConfig.
 */
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { createPermissionRule, evaluatePermissionRules } from "@agents-js/policy";
import type {
  PermissionRule,
  RememberedLifetime,
  RuleMatchResult,
} from "@agents-js/policy/permission-types";

interface LegacyPermissionRule extends PermissionRule {
  vaultPath?: string;
}

export class PermissionEngine {
  private rules: PermissionRule[] = [];

  /**
   * Load rules from persisted data.
   * Includes migration: accepts rules with legacy `vaultPath` field
   * and maps them to the canonical `workspacePath` field.
   */
  loadRules(rules: PermissionRule[] | LegacyPermissionRule[]): void {
    this.rules = rules.map((r) => {
      const legacyVaultPath = "vaultPath" in r ? r.vaultPath : undefined;
      return {
        ...r,
        workspacePath: r.workspacePath || legacyVaultPath || "",
      };
    });
  }

  /** Get all active rules */
  getRules(): readonly PermissionRule[] {
    return this.rules;
  }

  /** Add a new rule */
  addRule(rule: PermissionRule): void {
    this.rules.push(rule);
  }

  /** Remove a rule by ID */
  removeRule(ruleId: string): boolean {
    const idx = this.rules.findIndex((r) => r.id === ruleId);
    if (idx >= 0) {
      this.rules.splice(idx, 1);
      return true;
    }
    return false;
  }

  /** Remove all rules */
  clearAll(): void {
    this.rules = [];
  }

  /** Clear session-scoped rules (called on session end) */
  clearSessionRules(): void {
    this.rules = this.rules.filter((r) => r.lifetime === "persistent");
  }

  /** Clear single-use rules that have been consumed */
  clearConsumedOnceRules(): void {
    this.rules = this.rules.filter((r) => r.lifetime !== "once" || !r.consumed);
  }

  /**
   * Evaluate a permission request against stored rules.
   * Delegates to the stateless evaluatePermissionRules from @agents-js/policy,
   * then applies the returned updatedRules to internal state.
   */
  evaluate(
    request: RequestPermissionRequest,
    agentName: string,
    workspacePath: string,
  ): RuleMatchResult {
    const result = evaluatePermissionRules(request, agentName, workspacePath, this.rules);
    this.rules = result.updatedRules;
    return result.match;
  }

  /**
   * Create a rule from a permission request and user choice.
   * Delegates to createPermissionRule from @agents-js/policy.
   */
  createRule(
    request: RequestPermissionRequest,
    agentName: string,
    workspacePath: string,
    outcome: "allow" | "reject",
    lifetime: RememberedLifetime,
    selectedOptionId?: string,
    scopeOverride?: string,
  ): PermissionRule {
    return createPermissionRule(
      request,
      agentName,
      workspacePath,
      outcome,
      lifetime,
      selectedOptionId,
      scopeOverride,
    );
  }
}
