/**
 * JCS (JSON Canonical Serialization) — RFC 8785.
 *
 * Produces a deterministic, byte-exact representation of a JSON value
 * such that two semantically-equivalent values (e.g. object literals
 * with different key orders) produce identical byte sequences. Used
 * by AJS-55 (`agents-js-federation-peer-record-signing-2026-05-22.md`)
 * to canonicalize peer records before ed25519 signing — without
 * canonicalization, two byte-different but value-equivalent records
 * would have different signatures, breaking the verifier.
 *
 * Hand-rolled per the AJS-55 design's "no external dep" recommendation.
 * Reference: https://www.rfc-editor.org/rfc/rfc8785
 *
 * Scope: covers the JSON value subset AJS-55 actually serializes —
 * strings, booleans, nulls, arrays, and objects whose keys are strings.
 * Numbers are supported for integers and ECMAScript-canonical
 * representations (`String(n)`); non-finite numbers throw. The signed
 * portion of a peer record is string/array/object only, so number-
 * edge-cases (`1e+21`, `0.1+0.2`, etc.) are not on the AJS-55 hot path.
 * If callers need full RFC 8785 number coverage in the future, swap
 * {@link jcsNumber} for an implementation of RFC 8785 §3.2.2.3 (the
 * "Number Serialization Procedure").
 */

const ALWAYS_ESCAPED: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/**
 * Encode a JSON-compatible value to its JCS canonical UTF-8 string
 * form. The output is a STRING; encode to bytes via `new TextEncoder().encode(...)`
 * if you need the byte sequence for signing.
 *
 * @internal Implementation primitive for AJS-55 peer-record + challenge-mint
 *           signing. Public consumers should use `signPeerRecord` /
 *           `verifyPeerRecord` instead of canonicalizing themselves.
 */
export function jcs(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return jcsNumber(value);
  if (typeof value === "string") return jcsString(value);
  if (Array.isArray(value)) {
    return `[${value.map(jcs).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    // Sort by UTF-16 code-unit value of the key (NOT by codepoint —
    // RFC 8785 §3.2.3 explicitly specifies code-unit ordering, which
    // matches `String#localeCompare` semantics only for BMP-only keys
    // but diverges for surrogate-pair keys. ECMAScript's default
    // String comparison IS code-unit-based, so a < b comparison
    // suffices.).
    entries.sort(([a], [b]) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });
    return `{${entries.map(([k, v]) => `${jcsString(k)}:${jcs(v)}`).join(",")}}`;
  }
  if (value === undefined) {
    throw new Error("[jcs] undefined is not representable in JSON");
  }
  throw new Error(`[jcs] unsupported value type: ${typeof value}`);
}

/**
 * Serialize a JSON string per RFC 8785 §3.2.2.2:
 * - Escape `"`, `\`, control characters via short escapes where
 *   defined (`\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`)
 * - Escape other control chars (`U+0000` through `U+001F` except the
 *   already-covered ones above) as `\u00XX` lowercase hex
 * - Do NOT escape characters above U+007F (UTF-8 passthrough)
 * - Do NOT escape forward slash (RFC 8785 explicitly forbids `\/`)
 *
 * Surrogate pairs in the input are preserved as-is (JCS works on the
 * abstract Unicode string; JS Strings are UTF-16 internally, and the
 * UTF-8 transcode happens at the byte-output step).
 */
function jcsString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    const short = ALWAYS_ESCAPED[ch];
    if (short !== undefined) {
      out += short;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += ch;
  }
  return `${out}"`;
}

/**
 * Serialize a number. RFC 8785 §3.2.2.3 specifies the ECMAScript
 * Number.prototype.toString algorithm. For integer values and most
 * finite floats, this matches `String(n)`. Non-finite values (NaN,
 * Infinity) are NOT representable in JSON; throw. Edge cases like
 * `1e+21`, `-0`, very-small floats follow ECMA-262 §6.1.6.1.13
 * directly; AJS-55 doesn't exercise them today, so the simple path
 * is in v1.
 */
function jcsNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`[jcs] non-finite number is not representable in JSON: ${n}`);
  }
  if (Object.is(n, -0)) return "0"; // RFC 8785: -0 → "0"
  return String(n);
}
