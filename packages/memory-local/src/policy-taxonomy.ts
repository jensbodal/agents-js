import type { MemoryActor, MemoryScope } from "@agents-js/memory";
import type { MemoryPolicyGate, MemoryPolicyInput, MemoryPolicyResult } from "./policy-gate.ts";

/**
 * MemoryPolicy v1.2 — enumerated permission-gate taxonomy.
 *
 * Builds a default {@link MemoryPolicyGate} implementation on top of the
 * v1 contract (`allow | ask | deny` decisions; see `policy-gate.ts`).
 * The taxonomy enumerates the four canonical buckets every memory
 * operation falls into:
 *
 *   1. Local Recall — read-side; never gated in v1 (no read op).
 *   2. Project Write — writes scoped to an `agent` or `room`; allowed
 *      when the actor is the project actor for that scope, otherwise
 *      `ask`.
 *   3. Destructive — any delete OR any write to `scope.global`; requires
 *      a workspace consent token in metadata, otherwise `ask`.
 *   4. Configured Type — writes whose `type` is in an explicit
 *      registry (OpenMemory / Thoughtbox / similar); default-deny
 *      unless explicitly allow-listed or ask-listed in the gate's
 *      options.
 *
 * Precedence (deterministic, locked by `policy-taxonomy.test.ts`):
 *
 *   destructive  >  project-write
 *
 * Destructive ops trump every other rule — a delete on a configured
 * type still requires consent; a save to `scope.global` still requires
 * consent regardless of type. The configured-type bucket is a gate-side
 * refinement that only applies to project-scoped writes.
 *
 * Forward-compatibility note (AJS-11): the `ask` decision is the seam
 * an interactive consent prompt rides. The taxonomy stays a pure
 * decision reporter; the cross-host consent resolver lives outside this
 * file, in the provider boundary that already consults
 * `policyGate.evaluate`.
 */

/** Discriminated union of the four taxonomy categories. */
export type PolicyCategory =
  | { category: "local-recall" }
  | { category: "project-write"; scope: "agent" | "room" }
  | { category: "destructive"; reason: "delete" | "global-write" }
  | { category: "configured-type"; type: string };

/**
 * Map any `MemoryPolicyInput` to exactly one category. Pure function;
 * deterministic for identical inputs. Does NOT consult the gate's
 * configuredTypes option — the configured-type bucket is applied at the
 * gate layer, not in the classifier, because the classifier doesn't know
 * the gate's per-instance registry.
 */
export function classifyMemoryOperation(input: MemoryPolicyInput): PolicyCategory {
  if (input.op === "delete") {
    return { category: "destructive", reason: "delete" };
  }
  if (input.scope.kind === "global") {
    return { category: "destructive", reason: "global-write" };
  }
  if (input.scope.kind === "agent" || input.scope.kind === "room") {
    return { category: "project-write", scope: input.scope.kind };
  }
  // No read op exists in v1; this branch is defensive for the future
  // local-recall category.
  return { category: "local-recall" };
}

/**
 * Options for {@link createMemoryPolicyV12Gate}. Every option has a
 * conservative default — the safe-by-default posture is "ask" for
 * non-trivial decisions so a host with no policy plumbing fails closed
 * rather than open.
 */
export interface MemoryPolicyV12Options {
  /**
   * Per-type policy registry for the configured-type bucket (typically
   * OpenMemory / Thoughtbox or similar). Types in `allow` pass without
   * consent; types in `ask` return `ask`; types not in either list and
   * not in any other category fall through to project-write rules
   * (the registry is opt-in per type, not a global mode).
   */
  configuredTypes?: {
    allow?: readonly string[];
    ask?: readonly string[];
  };
  /**
   * Decides whether an actor is the project actor for a given scope.
   * Default: every actor is a non-project actor → project-writes
   * return `ask`. Override with a real ownership check (e.g. actor's
   * mxid matches the scope's owner).
   */
  isProjectActor?: (actor: MemoryActor, scope: MemoryScope) => boolean;
  /** Metadata key holding the workspace consent token. Default `"consentToken"`. */
  consentTokenKey?: string;
  /**
   * Validate the consent token. Default: any non-empty string is
   * accepted. Replace with a real signed-token validator (or wire to
   * an AJS-11 cross-host validator) for production deployments.
   */
  validateConsentToken?: (token: unknown, input: MemoryPolicyInput) => boolean;
}

const DEFAULT_CONSENT_TOKEN_KEY = "consentToken";
const DEFAULT_CONSENT_VALIDATOR = (token: unknown): boolean =>
  typeof token === "string" && token.length > 0;
const DEFAULT_IS_PROJECT_ACTOR = (): boolean => false;

/**
 * Build a {@link MemoryPolicyGate} implementing the v1.2 taxonomy. The
 * returned gate is stateless aside from the closed-over options — the
 * same instance is safe to share across providers and across concurrent
 * calls.
 */
export function createMemoryPolicyV12Gate(options: MemoryPolicyV12Options = {}): MemoryPolicyGate {
  const consentTokenKey = options.consentTokenKey ?? DEFAULT_CONSENT_TOKEN_KEY;
  const validateConsentToken = options.validateConsentToken ?? DEFAULT_CONSENT_VALIDATOR;
  const isProjectActor = options.isProjectActor ?? DEFAULT_IS_PROJECT_ACTOR;
  const allowTypes = new Set(options.configuredTypes?.allow ?? []);
  const askTypes = new Set(options.configuredTypes?.ask ?? []);

  function evaluateConfiguredType(type: string, reason: string): MemoryPolicyResult | undefined {
    if (allowTypes.has(type)) return { decision: "allow" };
    if (askTypes.has(type)) return { decision: "ask", reason };
    return undefined;
  }

  function checkConsent(input: MemoryPolicyInput, reason: string): MemoryPolicyResult {
    const token = input.metadata?.[consentTokenKey];
    if (validateConsentToken(token, input)) {
      return { decision: "allow" };
    }
    return { decision: "ask", reason };
  }

  return {
    async evaluate(input: MemoryPolicyInput): Promise<MemoryPolicyResult> {
      const category = classifyMemoryOperation(input);

      switch (category.category) {
        case "local-recall":
          return { decision: "allow" };

        case "destructive":
          return checkConsent(
            input,
            category.reason === "delete"
              ? "destructive delete requires a workspace consent token"
              : "destructive global-scope write requires a workspace consent token",
          );

        case "project-write": {
          // Configured-type refinement is checked BEFORE the
          // project-actor rule so an explicit type allow-list can
          // satisfy non-project actors without consent. Configured
          // types never bypass the destructive rule (handled above).
          const configured = evaluateConfiguredType(
            input.type,
            `configured type "${input.type}" requires explicit consent`,
          );
          if (configured) return configured;

          if (isProjectActor(input.actor, input.scope)) {
            return { decision: "allow" };
          }
          return {
            decision: "ask",
            reason: `project-write to scope.${category.scope} by non-project actor requires consent`,
          };
        }

        case "configured-type": {
          // Unreachable today — classifier never returns this category;
          // the gate handles configured-type as a refinement of
          // project-write. Defensive branch for shape exhaustiveness.
          const configured = evaluateConfiguredType(
            category.type,
            `configured type "${category.type}" requires explicit consent`,
          );
          return (
            configured ?? {
              decision: "deny",
              reason: `configured type "${category.type}" is not in the gate's allow/ask registry`,
            }
          );
        }
      }
    },
  };
}
