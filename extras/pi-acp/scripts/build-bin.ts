#!/usr/bin/env bun
// Build the pi-acp standalone binary with `bun build --compile`.
// The compiled binary wraps the native `pi --mode rpc` NDJSON stream as an
// ACP AgentSideConnection over stdio.
//
// By default the binary is compiled for the HOST architecture. Set
// `PI_ACP_COMPILE_TARGET` to a bun target token (e.g. `bun-linux-x64`,
// `bun-darwin-arm64`) to cross-compile — this is how a Linux runtime artifact
// is produced from a macOS dev box without the `ENOEXEC`-on-restart failure
// that a host-arch binary causes when copied to a mismatched host.
//
// On macOS targets, the compiled output is re-signed adhoc after build. macOS
// 26+ SIGKILLs bun-compiled binaries that retain bun's empty/malformed
// LC_CODE_SIGNATURE load command; the shared `scripts/sign-cli-bin.ts` helper
// (also used by @agents-js/cli) strips and re-applies a valid adhoc signature.
// The re-sign is gated on the *target* being darwin (see compile-plan.ts), so a
// Linux cross-build on a mac never tries to codesign a Linux ELF.

import { platform } from "node:os";
import { $ } from "bun";
import { resolveCompilePlan } from "./compile-plan.ts";

const plan = resolveCompilePlan(Bun.env.PI_ACP_COMPILE_TARGET, platform());
console.log(`[pi-acp] compiling for ${plan.targetLabel}`);

const build =
  await $`bun build --compile ${plan.compileArgs} --outfile dist/pi-acp src/bin.ts`.nothrow();

if (build.exitCode !== 0) {
  console.error("[pi-acp] bun build --compile failed");
  process.exit(build.exitCode);
}

// Re-sign for macOS kernel compatibility. The sign helper is shared with
// @agents-js/cli — path is relative to this package dir. Skipped for non-darwin
// targets so a Linux cross-build is not handed to `codesign`.
if (plan.shouldSign) {
  await $`bun ../../scripts/sign-cli-bin.ts dist/pi-acp`;
} else {
  console.log("[pi-acp] skipping macOS re-sign (non-darwin target)");
}
