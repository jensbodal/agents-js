#!/usr/bin/env bun
/**
 * ci-container.ts — Run a test command inside the same act-compatible container
 * image used for `runs-on: ubuntu-latest`, with an explicit image refresh
 * on every invocation.
 *
 * Motivation: `:latest` tags are cached forever by Docker once pulled. Running
 * `bun test` against an image pulled weeks ago is a silent-false-signal trap —
 * you think you repro'd CI's environment, but you actually tested against
 * whatever base layer happened to exist last time. This script forces a
 * registry check before every run so the local repro tracks what a cold CI
 * runner should pull.
 *
 * Known limitation: the active runner's own pull policy is outside our
 * control. If the runner is configured with `--pull=false` or sticky caching,
 * it may be serving an image older than the one this script runs against.
 * For deeper parity, confirm the runner's pull policy with the operator.
 *
 * Usage:
 *   bun scripts/ci-container.ts <test-path> [<test-path>...]
 *   bun scripts/ci-container.ts --shell    # drop into an interactive shell
 *
 * Example:
 *   bun scripts/ci-container.ts \
 *     packages/acp-host/tests/connection.test.ts \
 *     packages/cli/tests/terminal-manager.test.ts
 */

import { spawnSync } from "node:child_process";
import { repoRoot } from "./workspace-config.ts";

const IMAGE = "catthehacker/ubuntu:act-latest";

function run(cmd: string, args: string[], opts: { inherit?: boolean } = {}): number {
  const result = spawnSync(cmd, args, {
    stdio: opts.inherit === false ? "pipe" : "inherit",
    cwd: repoRoot,
  });
  if (result.error) {
    console.error(`[ci-container] failed to spawn ${cmd}: ${result.error.message}`);
    return 127;
  }
  return result.status ?? 1;
}

function pullImage(): number {
  console.log(
    `[ci-container] pulling ${IMAGE} (always — '${IMAGE.split(":")[1]}' is a moving tag)`,
  );
  return run("docker", ["pull", IMAGE]);
}

function runInContainer(testArgs: string[], interactive: boolean): number {
  const installScript = [
    // Bun installer script writes to ~/.bun and prints a banner; silence it.
    "curl -fsSL https://bun.sh/install | bash >/dev/null",
    'export PATH="$HOME/.bun/bin:$PATH"',
    "bun --version",
    "bun install --frozen-lockfile",
  ].join(" && ");

  const testCommand = interactive
    ? `${installScript} && exec bash`
    : `${installScript} && bun test ${testArgs.map((a) => `'${a}'`).join(" ")}`;

  const dockerArgs = [
    "run",
    "--rm",
    ...(interactive ? ["-it"] : []),
    "-v",
    `${repoRoot}:/w`,
    "-w",
    "/w",
    IMAGE,
    "bash",
    "-lc",
    testCommand,
  ];

  console.log(`[ci-container] docker ${dockerArgs.slice(0, 7).join(" ")} ... (image=${IMAGE})`);
  return run("docker", dockerArgs);
}

const rawArgs = process.argv.slice(2);
const interactive = rawArgs.includes("--shell");
const testArgs = rawArgs.filter((a) => a !== "--shell");

if (!interactive && testArgs.length === 0) {
  console.error("Usage: bun scripts/ci-container.ts <test-path>... | --shell");
  process.exit(2);
}

const pullCode = pullImage();
if (pullCode !== 0) {
  console.error(`[ci-container] docker pull failed (${pullCode}); aborting`);
  process.exit(pullCode);
}

const runCode = runInContainer(testArgs, interactive);
process.exit(runCode);
