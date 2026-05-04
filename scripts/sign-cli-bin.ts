#!/usr/bin/env bun
// Apply a valid ad-hoc code signature to a `bun build --compile` output so
// macOS 26+ accepts it. Bun's compile step leaves an LC_CODE_SIGNATURE load
// command pointing at an empty/malformed signature section; newer macOS
// SIGKILLs binaries in that state. See docs/runbooks/bugfix-log.md entry
// "agents-js killed by macOS 26+ kernel" for the full investigation.
//
// No-op on platforms without `codesign` (Linux CI). Failures of the sign or
// verify steps exit non-zero; failure of the initial strip is expected and
// tolerated (a freshly-compiled binary may not have a removable signature in
// every bun version).

import { spawnSync } from "node:child_process";
import { platform } from "node:os";

const target = Bun.argv[2];
if (!target) {
  console.error("usage: sign-cli-bin.ts <path-to-binary>");
  process.exit(1);
}

if (platform() !== "darwin") {
  process.exit(0);
}

// Strip whatever bun left behind. Expected to fail on already-clean binaries;
// stderr is visible so real errors surface.
spawnSync("codesign", ["--remove-signature", target], { stdio: "inherit" });

for (const args of [
  ["--force", "--sign", "-", target],
  ["--verify", target],
]) {
  const result = spawnSync("codesign", args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
