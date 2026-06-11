/**
 * Internal validation primitives shared by the M1 sidecar-schema validators.
 *
 * These are deliberately dependency-free hand-rolled guards (no validation
 * library is pulled into the published `@agents-js/schema-utils` surface) and
 * are NOT re-exported from the package barrel — they are an implementation
 * detail of the per-schema `parse*`/`is*` validators.
 */

/** True for a non-null, non-array object literal. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `value` is an array whose every element is a string. */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** True when `value` is a non-empty string. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Strict key-set equality: the object's keys must be EXACTLY `allowed` — no
 * unknown keys (which would let a projection/authority field leak in) and no
 * missing keys. This is what makes the "enforced by absence" boundaries
 * (no `matrix_*`, no blocking field) testable at runtime rather than only at
 * the type level.
 */
export function hasExactKeys(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(obj);
  if (keys.length !== allowed.length) return false;
  const allowedSet = new Set(allowed);
  return keys.every((key) => allowedSet.has(key));
}

/** Membership test against a readonly enum tuple. */
export function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

/** True when `value` is a `sha256:<64 lowercase hex>` digest reference. */
export function isSha256Ref(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

/**
 * True when `value` is a prefixed ULID of the form `<prefix>_<26 Crockford
 * base32 chars>` (e.g. `run_01J9Z3K8...`). ID generation is the runtime
 * writer's concern; the schema only validates the format.
 */
export function isPrefixedUlid(value: unknown, prefix: string): value is string {
  if (typeof value !== "string") return false;
  const re = new RegExp(`^${prefix}_[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$`);
  return re.test(value);
}

/**
 * True when `value` is an ISO-8601 timestamp carrying an explicit Pacific
 * offset (`-07:00` PDT or `-08:00` PST) — the fleet's accepted standup
 * convention. A bare `Z`, a naive timestamp, or any non-Pacific offset is
 * rejected so the authoritative record cannot drift between zones.
 */
export function isPacificIso8601(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?-0[78]:00$/.test(value);
}
