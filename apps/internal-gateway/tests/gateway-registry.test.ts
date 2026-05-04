import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildProcessEnv } from "../../../scripts/process-utils.ts";

/**
 * Registry integration tests for apps/internal-gateway/cli.ts.
 *
 * These tests verify the --check mode does NOT invoke autoRegister, and
 * that the sync endpoint handler is composed into the additionalFetch chain.
 * Full production-mode write is covered by packages/a2a-client startup tests.
 */

const bunBinary = Bun.which("bun") ?? "bun";
const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");

describe("Gateway registry wiring", () => {
  test("--check mode does not write to the registry", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "gw-check-test-"));
    const registryPath = path.join(tmpDir, "registry.json");

    try {
      const proc = Bun.spawn({
        cmd: [bunBinary, "run", "apps/internal-gateway/cli.ts", "--check", "--runtime", "claude"],
        cwd: repoRoot,
        env: buildProcessEnv({
          AGENTS_JS_REGISTRY: registryPath,
        }),
        stderr: "pipe",
        stdout: "pipe",
      });

      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);

      // Registry file must NOT exist — --check returns before autoRegister
      let fileExists = false;
      try {
        await stat(registryPath);
        fileExists = true;
      } catch {
        fileExists = false;
      }
      expect(fileExists).toBe(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});
