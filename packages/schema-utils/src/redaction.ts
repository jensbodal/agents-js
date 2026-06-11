import { hasExactKeys, isOneOf, isPlainObject, isSha256Ref } from "./_validate.ts";

/**
 * Shared redaction rule for both M1 sidecar schemas (`run-ledger.v0` and
 * `context-bundle.v0`).
 *
 * A redaction is RECORDED, never silent: the secret is removed at write time
 * and replaced by this `{path, reason, digest}` record, so a record is
 * verifiably "complete minus these N known, hashed removals." The `digest` is
 * the sha256 of the *redacted value* — it lets a later check compare "same
 * secret?" without ever storing the secret. Silent dropping is forbidden: it
 * would make the ledger digest chain unverifiable and hide that data existed.
 */
export interface RedactionRecord {
  /** JSON path of the removed value within the record (e.g. `evidence[0].ref`). */
  path: string;
  /** Why it was removed (v0 enum; extensible in v1). */
  reason: "secret-token" | "pii" | "oversized" | "policy";
  /** sha256 of the redacted value, for later equality checks without storage. */
  digest: string;
}

/** The v0 redaction-reason vocabulary. */
export const REDACTION_REASONS = ["secret-token", "pii", "oversized", "policy"] as const;

const KEYS = ["path", "reason", "digest"] as const;

function check(value: unknown): string | null {
  if (!isPlainObject(value)) return "not a plain object";
  if (!hasExactKeys(value, KEYS)) return `keys must be exactly [${KEYS.join(", ")}]`;
  if (typeof value.path !== "string") return "path must be a string";
  if (!isOneOf(value.reason, REDACTION_REASONS)) {
    return `reason must be one of [${REDACTION_REASONS.join(", ")}]`;
  }
  if (!isSha256Ref(value.digest)) return "digest must be a sha256:<64 hex> ref";
  return null;
}

/** Type guard: true iff `value` is a structurally-valid `RedactionRecord`. */
export function isRedactionRecord(value: unknown): value is RedactionRecord {
  return check(value) === null;
}

/** Parse-or-throw; throws `TypeError` with the first failing constraint. */
export function parseRedactionRecord(value: unknown): RedactionRecord {
  const reason = check(value);
  if (reason !== null) throw new TypeError(`invalid RedactionRecord: ${reason}`);
  return value as RedactionRecord;
}
