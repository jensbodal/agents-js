#!/usr/bin/env bun
// Build the pi-acp standalone binary with `bun build --compile`.
// The compiled binary wraps the native `pi --mode rpc` NDJSON stream as an
// ACP AgentSideConnection over stdio.
//
// On macOS, the compiled output is re-signed adhoc after build. macOS 26+
// SIGKILLs bun-compiled binaries that retain bun's empty/malformed
// LC_CODE_SIGNATURE load command; the shared `scripts/sign-cli-bin.ts`
// helper (also used by @agents-js/cli) strips and re-applies a valid
// adhoc signature. On Linux the helper is a no-op.

import { $ } from "bun";

const build = await $`bun build --compile --outfile dist/pi-acp src/bin.ts`.nothrow();

if (build.exitCode !== 0) {
  console.error("[pi-acp] bun build --compile failed");
  process.exit(build.exitCode);
}

// Re-sign for macOS kernel compatibility. The sign helper is shared with
// @agents-js/cli — path is relative to this package dir.
await $`bun ../../scripts/sign-cli-bin.ts dist/pi-acp`;
