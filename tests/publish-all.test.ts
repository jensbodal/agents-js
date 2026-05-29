import { describe, expect, test } from "bun:test";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

describe("publish-all", () => {
  test("resolves publishable extras packages from their real workspace path", async () => {
    const env = {
      ...process.env,
      AGENTS_JS_PUBLISH_REGISTRY: "https://registry.invalid/",
    };
    delete env.NPM_CONFIG_REGISTRY;
    delete env.npm_config_registry;

    const proc = Bun.spawn(
      ["bun", "scripts/publish-all.ts", "--package", "wake-channel-bridge", "--skip-build"],
      {
        cwd: repoRoot,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const output = `${stdout}\n${stderr}`;

    expect([0, 1]).toContain(exitCode);
    expect(output).toContain("@agents-js/wake-channel-bridge");
    expect(output).toContain("extras/wake-channel-bridge");
    expect(output).not.toContain("Package directory not found");
    expect(output).not.toContain("packages/wake-channel-bridge");
  });
});
