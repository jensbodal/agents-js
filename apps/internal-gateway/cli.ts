#!/usr/bin/env bun
/**
 * Runnable CLI entry for the gateway.
 *
 * Role split:
 *  - `cli.ts` (this file) is the process boundary: it owns argv, exit
 *    codes, and top-level error formatting.
 *  - `main.ts` is the orchestration assembly: it wires CLI args, runtime
 *    selection, the A2A server, the WebSocket bridge, and signal
 *    handlers. It does not call `process.exit` and does not parse argv.
 *  - `index.ts` is a pure barrel re-exporting the public surface; it is
 *    not runnable.
 *
 * This is a dedicated bin file (the package.json `bin` entry
 * `agents-js-gateway`, plus direct invocation via the `dev` /
 * `check:runtime` scripts). It always executes as the entry point —
 * no `import.meta.main` guard is needed. `package.json "main"` points
 * at `index.ts` (the pure barrel) so `import "@agents-js/gateway"`
 * cannot accidentally execute the gateway process at import time.
 */
import { describeGatewayError } from "./error-utils.ts";
import { main } from "./main.ts";

try {
  process.exit(await main());
} catch (error) {
  // `describeGatewayError` unwraps JSON-RPC error envelopes (`error.data.details`)
  // and other structured shapes that bare `console.error(err)` would print as
  // `[object Object]`.
  console.error(`[Gateway] ${describeGatewayError(error)}`);
  process.exit(1);
}
