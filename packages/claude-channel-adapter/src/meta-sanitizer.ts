/**
 * Hyphen-drop guard at the `notifications/claude/channel` `meta` boundary.
 *
 * **Why this exists**
 *
 * Claude Code's Channels protocol surfaces `meta` keys as attributes of the
 * `<channel>` tag injected into the system prompt. The serializer only
 * accepts identifier-shaped keys: underscores are kept, hyphens are
 * SILENTLY DROPPED. A `meta` payload with `{ "matrix-origin": "..." }` will
 * reach the listener but the attribute vanishes from the rendered
 * `<channel>` tag, producing a silent-failure data-loss bug.
 *
 * The defense is at this module's seam — the adapter SHOULD NOT emit any
 * meta payload that has not passed through {@link sanitizeMetaForChannel}.
 * This module either rejects (default) or auto-rewrites (explicit
 * `autoRewrite: true`) hyphenated keys, exposing the constraint at the
 * adapter boundary instead of relying on caller discipline.
 *
 * **Critique-first reasoning (boundaries/defaults/contracts/safety/validation)**
 *
 * - **Boundary**: this module is the LAST place hyphens are tolerated; every
 *   downstream consumer can assume identifier-shaped keys.
 * - **Default**: reject (throw) on hyphen detection — fail-loud beats
 *   silent-drop. Callers that want auto-rewrite opt in explicitly.
 * - **Contract**: returns a {@link SanitizedMeta} branded shape so the type
 *   system can carry the post-sanitization invariant through the codebase.
 * - **Safety**: identifier shape per JavaScript spec — leading non-digit,
 *   followed by alphanumeric/underscore. We intentionally REJECT non-ASCII
 *   identifiers because Claude Code's serializer behavior on those is
 *   unverified; lift the constraint when hostname-null's harness lane
 *   confirms multi-byte support.
 * - **Validation**: unit tests cover the three regimes (clean pass,
 *   hyphen-reject, auto-rewrite collision when two source keys collapse to
 *   the same target after underscore-replace).
 */

/**
 * Output shape of {@link sanitizeMetaForChannel}. Type alias rather than a
 * branded type so consumers can spread/compare with plain records; the
 * post-sanitization invariant is enforced by the seam (consumers that
 * route through `sanitizeMetaForChannel` get the guarantee; consumers that
 * skip the seam don't).
 */
export type SanitizedMeta = Readonly<Record<string, unknown>>;

/** Options for {@link sanitizeMetaForChannel}. */
export interface SanitizeMetaOptions {
  /**
   * When `true`, auto-rewrite hyphens to underscores instead of throwing.
   * Default `false` — fail-loud is the safer default; callers who know
   * their input has hyphens and accept the rewrite opt in explicitly.
   *
   * Auto-rewrite still throws on collision (two source keys collapse to
   * the same target after rewrite) — collision-on-rewrite is unambiguous
   * data loss and merits a hard failure.
   */
  readonly autoRewrite?: boolean;
}

/**
 * Identifier shape per JavaScript / Claude Code serializer:
 * leading letter or underscore, followed by alphanumeric or underscore.
 * Intentionally rejects non-ASCII identifiers until harness lane confirms
 * multi-byte serialization behavior.
 */
const META_KEY_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Reject (or with `autoRewrite: true`, rewrite) hyphenated meta keys
 * before they reach the `notifications/claude/channel` `meta` field.
 *
 * @throws `Error` when a hyphenated key is detected and `autoRewrite` is
 *   not set, or when auto-rewrite produces a collision between two source
 *   keys that collapse to the same target after rewrite.
 */
export function sanitizeMetaForChannel(
  raw: Readonly<Record<string, unknown>>,
  options: SanitizeMetaOptions = {},
): SanitizedMeta {
  const autoRewrite = options.autoRewrite ?? false;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    // Collision-aware assignment: raw input cannot contain JS-level
    // duplicate keys (those collapse before sanitization sees them), so any
    // post-write collision below is always caused by autoRewrite mapping
    // two distinct source keys onto the same target. We detect from both
    // sides of the collision (rewrite-first vs identifier-first input
    // order) by checking `in out` on every path.
    if (META_KEY_IDENTIFIER.test(key)) {
      if (key in out) {
        throw new Error(
          `[claude-channel-adapter] meta key "${key}" collides with an auto-rewritten key — refusing to merge silently`,
        );
      }
      out[key] = value;
      continue;
    }

    if (!autoRewrite) {
      throw new Error(
        `[claude-channel-adapter] meta key "${key}" is not an identifier (Claude Code's serializer silently drops hyphenated keys; pass autoRewrite: true to convert to underscores, or rename at the call site)`,
      );
    }

    const rewritten = key.replace(/-/g, "_");
    if (!META_KEY_IDENTIFIER.test(rewritten)) {
      throw new Error(
        `[claude-channel-adapter] meta key "${key}" cannot be rewritten to an identifier (non-hyphen non-identifier characters present)`,
      );
    }
    if (rewritten in out) {
      throw new Error(
        `[claude-channel-adapter] meta key "${key}" auto-rewrites to "${rewritten}" which collides with an existing key — refusing to merge silently`,
      );
    }
    out[rewritten] = value;
  }

  return out;
}
