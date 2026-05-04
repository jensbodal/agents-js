/**
 * Secure-context-safe RFC 4122 v4 UUID generator.
 *
 * Browsers only expose `crypto.randomUUID()` in secure contexts
 * (HTTPS origins or `localhost` / `127.0.0.1`). Serving the
 * reference web-ui over plain HTTP on a non-localhost hostname —
 * e.g. a Tailscale-exposed dev server — lands callers in an
 * insecure context where `crypto.randomUUID` is `undefined`, and
 * any consumer of `@agents-js/a2a-client` that calls it throws on
 * construction, producing an empty-page failure mode.
 *
 * `crypto.getRandomValues()` IS available in insecure contexts. This
 * helper uses the native `randomUUID()` when present and falls back
 * to a manual v4 construction from random bytes otherwise. Node and
 * Bun always have `randomUUID`, so the fallback only kicks in for
 * browsers loaded over plain HTTP on a non-localhost origin.
 *
 * See: https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID
 *      https://w3c.github.io/webcrypto/#SecureContext
 */
export function randomUuid(): string {
  const cryptoRef = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") {
    return cryptoRef.randomUUID();
  }
  return fallbackV4(cryptoRef);
}

function fallbackV4(cryptoRef: Crypto | undefined): string {
  if (!cryptoRef || typeof cryptoRef.getRandomValues !== "function") {
    throw new Error(
      "[a2a-client/uuid] Neither crypto.randomUUID nor crypto.getRandomValues is available in this environment.",
    );
  }
  const bytes = new Uint8Array(16);
  cryptoRef.getRandomValues(bytes);
  // RFC 4122 §4.4: set version (v4) and variant (10xx) bits.
  // Non-null assertions are safe: bytes is a freshly-allocated Uint8Array(16).
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
