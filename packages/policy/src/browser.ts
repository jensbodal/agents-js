/**
 * Browser-safe entry point for @agents-js/policy.
 *
 * The policy package is pure TypeScript — describe-permission, path-utils,
 * errors, permission-engine, permission-types, terminal-policy, and
 * write-gate all carry zero Node-only runtime dependencies — so in
 * principle the browser surface is identical to the main surface.
 *
 * This entry intentionally narrows to the symbols that browser-target
 * consumers actually use today (the plugin preview harness, for scope
 * computation in permission-rule construction). Keep it minimal and expand
 * only when a new browser consumer needs another symbol; do NOT broaden to
 * a full `./index.ts` re-export, which would let browser callers reach for
 * APIs whose browser-safety has not been explicitly considered.
 *
 * The `browser` export condition in package.json hands bundlers off to
 * this file so downstream consumers never need to reach into `src/` or
 * author a shim.
 */

export {
  classifyOperation,
  createPermissionRule,
  extractResourceScope,
  generateScopeCandidates,
} from "./permission-engine.ts";
