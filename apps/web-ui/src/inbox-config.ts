/**
 * Pure config parsing for the agent inbox browser (`inbox.ts` entry).
 *
 * Extracted from the entry module so it is unit-testable without the DOM
 * side effects (`registerAllComponents`, `#app` mount) that `inbox.ts` runs
 * on import — mirrors the `dashboard-data.ts` ↔ `dashboard-root.ts` split.
 *
 * Error handling here is a LOCAL typed error (`InboxConfigError`: a stable
 * machine-readable `code` + a human `message`), replacing the prior bare
 * error string. It foreshadows the shared typed-error model in ADR 0010
 * (post-0.6.x) — using the same `<domain>/<slug>` code convention — without
 * depending on it. The caller logs the typed error at the call site (see
 * `inbox.ts`); the presentational component keeps a string-only `errorMessage`.
 */

export interface InboxBrowserConfig {
  gatewayUrl: string;
  token: string;
  target?: string;
  limit?: number;
}

/** Stable error codes for inbox config parsing (`<domain>/<slug>`, per ADR 0010). */
export type InboxConfigErrorCode = "inbox/missing-token" | "inbox/invalid-limit";

export interface InboxConfigError {
  /** Stable, machine-readable code — never localized, safe to switch on. */
  readonly code: InboxConfigErrorCode;
  /** Human-readable, user-facing message for the error banner. */
  readonly message: string;
}

/** Narrow a {@link parseInboxConfig} result to its typed-error branch. */
export function isInboxConfigError(
  value: InboxBrowserConfig | InboxConfigError,
): value is InboxConfigError {
  return "code" in value;
}

/**
 * Parse the URL hash into an inbox config, or a typed {@link InboxConfigError}.
 *
 * Hash format: `#gateway=<url>&token=<jwt>&target=<session>&limit=<n>`
 * - `token` is REQUIRED — the agent-identity JWT for `/api/agents/get_messages`
 *   (distinct from any human-session auth, which is an edge-layer concern).
 * - `gateway` defaults to `defaultGatewayUrl`; `target` defaults to self-session;
 *   `limit` is an optional positive integer.
 *
 * `defaultGatewayUrl` is injected (rather than read from `window.location`) so
 * this function is pure and testable.
 */
export function parseInboxConfig(
  hash: string,
  defaultGatewayUrl: string,
): InboxBrowserConfig | InboxConfigError {
  const cleaned = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(cleaned);
  const token = params.get("token");
  if (!token) {
    return {
      code: "inbox/missing-token",
      message:
        "Missing required URL hash parameter `token`. Construct URL as #gateway=<url>&token=<jwt>&target=<session>&limit=<n>",
    };
  }
  const limitRaw = params.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    return {
      code: "inbox/invalid-limit",
      message: `Invalid \`limit\` value "${limitRaw}" — must be a positive integer.`,
    };
  }
  return {
    gatewayUrl: params.get("gateway") ?? defaultGatewayUrl,
    token,
    target: params.get("target") ?? undefined,
    limit,
  };
}
