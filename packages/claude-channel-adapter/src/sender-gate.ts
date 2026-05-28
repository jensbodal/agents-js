/**
 * Sender-agent-identity gate for `notifications/claude/channel` emissions.
 *
 * **Why this exists**
 *
 * Per hostname-null's protocol research (`agents/claude-code-push-via-agents-js-2026-05-28`),
 * Channels security requires gating on SENDER AGENT IDENTITY (not chat/room
 * id) before emitting into Claude Code's session. Anything that reaches the
 * `<channel>` injection point becomes prompt context — an unauthenticated
 * sender is a prompt-injection vector.
 *
 * **Critique-first reasoning (boundaries/defaults/contracts/safety/validation)**
 *
 * - **Boundary**: this module is the gate between gateway-event-receipt and
 *   `notifications/claude/channel` emit. Every emit path MUST pass through a
 *   {@link SenderGate} check.
 * - **Default**: deny-unknown — callers who don't supply an allowlist get a
 *   gate that rejects everything. Fail-closed beats fail-open for a
 *   prompt-injection surface.
 * - **Contract**: small interface (`allow(sender) => boolean`) so future
 *   extraction to `@agents-js/policy` is a one-shape lift, not a refactor.
 *   Config-side accepts a static allowlist OR a dynamic callback so an
 *   operator who wants per-tenant or per-source-class policy can plug it in.
 * - **Safety**: sender identity is matched via exact string compare (no
 *   case-folding, no normalization). Operators provide identities exactly
 *   as the gateway emits them. Future ADR can codify normalization rules.
 * - **Validation**: unit tests cover allow-list pass, deny-unknown,
 *   dynamic-callback pass/deny, and missing-config deny-all.
 *
 * **Extraction-readiness**
 *
 * The {@link SenderGate} interface + {@link createSenderGate} factory are
 * deliberately small. When a second consumer needs sender-agent-identity
 * gating, the contract lifts unchanged to `@agents-js/policy`. AJS-XX
 * tracker will file when the second consumer surfaces; until then, this is
 * local-only to the channel adapter.
 */

/** Result of a {@link SenderGate} check. */
export interface SenderGate {
  /** Returns `true` iff `sender` is authorized to emit into the channel. */
  allow(sender: string): boolean;
}

/** Configuration for {@link createSenderGate}. */
export interface SenderGateConfig {
  /**
   * Explicit allowlist of sender agent identities. An empty array or
   * `undefined` means "no static entries" — combine with {@link allow}
   * for dynamic policy, or omit both to deny everything.
   */
  readonly allowedSenders?: readonly string[];
  /**
   * Dynamic policy callback. Invoked AFTER the static allowlist check
   * fails, so a static `allowedSenders` membership is the fast path.
   * Throwing or returning `false` denies.
   */
  readonly allow?: (sender: string) => boolean;
}

/**
 * Build a {@link SenderGate} from static allowlist + optional dynamic
 * callback. Deny-unknown by default — a gate with no `allowedSenders` and
 * no `allow` callback rejects every sender.
 */
export function createSenderGate(config: SenderGateConfig = {}): SenderGate {
  const staticAllowlist = new Set(config.allowedSenders ?? []);
  const dynamicAllow = config.allow;

  return {
    allow(sender: string): boolean {
      if (staticAllowlist.has(sender)) return true;
      if (dynamicAllow === undefined) return false;
      try {
        return dynamicAllow(sender) === true;
      } catch {
        // Dynamic policy errors collapse to deny — fail-closed for
        // prompt-injection surface. Operator who wants observability
        // can wrap their own callback to log + re-throw before deny.
        return false;
      }
    },
  };
}
