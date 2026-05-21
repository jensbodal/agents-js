/**
 * Centralized HTTP status code constants for any module in the monorepo
 * that constructs a `Response` object.
 *
 * **Inclusion policy**: this list is intentionally narrow — only codes the
 * monorepo actually emits in production responses. Add a code here when
 * you need to emit it from a `Response`; do not pre-populate codes for
 * codes we might emit someday. Importing the constant elsewhere when the
 * codebase doesn't actually emit it adds noise without adding value.
 *
 * Names follow the legacy RFC 7231 / IANA registry shape (e.g.
 * `PAYLOAD_TOO_LARGE` rather than the RFC 9110 rename "Content Too Large")
 * to match what TS / Node / browser docs and most third-party libraries
 * still call the codes.
 */
export const HTTP_STATUS = {
  // 2xx — success
  OK: 200,
  NO_CONTENT: 204,
  // 4xx — client error
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  NOT_ACCEPTABLE: 406,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UPGRADE_REQUIRED: 426,
  // 5xx — server error
  INTERNAL_SERVER_ERROR: 500,
} as const;

/**
 * Union of the numeric values in {@link HTTP_STATUS}. Useful for typing
 * custom handler return values or status-code routing tables that should
 * only accept codes the monorepo emits.
 */
export type HttpStatus = (typeof HTTP_STATUS)[keyof typeof HTTP_STATUS];
