#!/usr/bin/env bun
// Build the agents-js standalone binary with embedded git build metadata.
// The constants are injected via `bun build --define` and consumed in
// packages/cli/src/cli.ts (via `declare const __AGENTS_JS_BUILD_*__`).
//
// Running the compiled binary produces output like:
//   agents-js 0.2.0-beta-3 (b1dc16c, built 2026-04-17T23:45:12Z)
// or with --dirty:
//   agents-js 0.2.0-beta-3 (b1dc16c-dirty, built 2026-04-17T23:45:12Z)
//
// Running from source (`bun src/cli.ts --version`) shows:
//   agents-js 0.2.0-beta-3 (source)

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { $ } from "bun";

const sha = (await $`git rev-parse --short HEAD`.text()).trim();

// Exit 0 = clean, 1 = dirty. Ignore generated dist/ and node_modules/.
const dirtyResult = await $`git diff --quiet HEAD -- . ':!dist' ':!node_modules'`.nothrow().quiet();
const dirty = dirtyResult.exitCode === 0 ? "false" : "true";

const date = new Date().toISOString();
const outputPath = Bun.env.AGENTS_JS_STANDALONE_OUTFILE ?? "artifacts/agents-js";

await mkdir(dirname(outputPath), { recursive: true });

console.log(`Building agents-js binary: sha=${sha} dirty=${dirty} date=${date}`);

const build = await $`bun build \
  --compile \
  --minify \
  --define __AGENTS_JS_BUILD_SHA__="\"${sha}\"" \
  --define __AGENTS_JS_BUILD_DIRTY__="\"${dirty}\"" \
  --define __AGENTS_JS_BUILD_DATE__="\"${date}\"" \
  --outfile ${outputPath} \
  src/cli.ts`.nothrow();

if (build.exitCode !== 0) {
  console.error("bun build --compile failed");
  process.exit(build.exitCode);
}

// Existing sign step — relative to this package dir.
await $`bun ../../scripts/sign-cli-bin.ts ${outputPath}`;
