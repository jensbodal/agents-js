/**
 * Shared logger contract for `@agents-js/plane`. Mirrors the `console`
 * shape so a bare `console` satisfies it without adapter code.
 */
export interface Logger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
