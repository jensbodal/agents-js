/**
 * Browser-safe entry for `@agents-js/trial-agent`.
 *
 * The trial agent's runtime is a Node/Bun stdio ACP server that walks the
 * filesystem; nothing here can run in a browser bundle. This entry exists
 * so bundlers that auto-resolve the `browser` export condition fail loudly
 * with a useful error message instead of pulling in `node:fs/promises`
 * transitively via the full server build.
 */

const NOT_BROWSER_SAFE =
  "@agents-js/trial-agent is a Node/Bun stdio ACP server and cannot run in a browser. " +
  "Spawn the `trial-agent` binary as a subprocess from a server-side runtime instead.";

throw new Error(NOT_BROWSER_SAFE);
