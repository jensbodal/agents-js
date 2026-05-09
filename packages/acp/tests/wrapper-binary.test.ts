import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/wrapper-fixture.ts");

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runFixture(args: readonly string[]): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", FIXTURE, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.once("exit", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

describe("runAcpWrapperBinary", () => {
  test("--help prints name + em-dash + helpText and exits 0", async () => {
    const result = await runFixture(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("fixture-acp — fixture help body");
  }, 10000);

  test("-h is a synonym for --help", async () => {
    const result = await runFixture(["-h"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("fixture-acp — fixture help body");
  }, 10000);

  test("--version prints name + space + version and exits 0", async () => {
    const result = await runFixture(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("fixture-acp 9.9.9\n");
  }, 10000);

  test("-v is a synonym for --version", async () => {
    const result = await runFixture(["-v"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("fixture-acp 9.9.9\n");
  }, 10000);

  test("non-adapter flags are forwarded into createAgent", async () => {
    // Drive the fixture far enough for createAgent() to fire by sending an
    // ACP `initialize` request, then close stdin. The fixture writes the
    // captured forwarded argv to stderr; we assert on that.
    const child = spawn(
      "bun",
      ["run", FIXTURE, "--provider", "zai", "--model", "glm-5.1", "--flag-only"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const errChunks: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => errChunks.push(c));
    const exitPromise = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
    });

    const initialize = `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    })}\n`;
    child.stdin.write(initialize);

    // Wait until the FORWARDED line shows up on stderr — that proves the
    // agent factory ran with the parsed argv.
    const observed = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5000);
      const check = () => {
        const joined = Buffer.concat(errChunks).toString("utf8");
        const line = joined.split("\n").find((l) => l.startsWith("FORWARDED:"));
        if (line) {
          clearTimeout(timer);
          resolve(line);
        }
      };
      child.stderr.on("data", check);
      check();
    });

    child.stdin.end();
    child.kill("SIGTERM");
    await Promise.race([exitPromise, Bun.sleep(3000)]);
    if (child.exitCode === null) child.kill("SIGKILL");

    const payload = JSON.parse(observed.slice("FORWARDED:".length));
    expect(payload).toEqual(["--provider", "zai", "--model", "glm-5.1", "--flag-only"]);
  }, 15000);

  test("SIGTERM exits within the grace window", async () => {
    const child = spawn("bun", ["run", FIXTURE], { stdio: ["pipe", "pipe", "pipe"] });
    const exitPromise = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
    });
    await Bun.sleep(150);
    child.kill("SIGTERM");
    const code = await Promise.race([exitPromise, Bun.sleep(5000).then(() => "timeout" as const)]);
    if (code === "timeout") {
      child.kill("SIGKILL");
      throw new Error("fixture did not exit within 5s of SIGTERM");
    }
    expect(code === null || typeof code === "number").toBe(true);
  }, 10000);
});
