#!/usr/bin/env bun

import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const claudeAgentPackageName = "@agentclientprotocol/claude-agent-acp";
const codexAgentPackageName = "@zed-industries/codex-acp";
const packageDirs = {
  policy: path.join(repoRoot, "packages", "policy"),
  validation: path.join(repoRoot, "packages", "validation"),
  schemaUtils: path.join(repoRoot, "packages", "schema-utils"),
  acp: path.join(repoRoot, "packages", "acp"),
  acpHost: path.join(repoRoot, "packages", "acp-host"),
  a2a: path.join(repoRoot, "packages", "a2a"),
  a2aClient: path.join(repoRoot, "packages", "a2a-client"),
  gatewayRuntime: path.join(repoRoot, "packages", "gateway-runtime"),
  cli: path.join(repoRoot, "packages", "cli"),
} as const;

type PackageManifest = {
  name: string;
  version: string;
};

type SmokeConsumerPackageJson = {
  name: string;
  private: true;
  overrides: Record<string, string>;
  dependencies: Record<string, string>;
};

async function runCommand(argv: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: process.env,
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(
      [
        `[cli-package-smoke] Command failed (${exitCode}): ${argv.join(" ")}`,
        stdout.trim(),
        stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return stdout;
}

async function readManifest(packageDir: string): Promise<PackageManifest> {
  return Bun.file(path.join(packageDir, "package.json")).json();
}

async function buildPackage(packageDir: string): Promise<void> {
  await runCommand(["bun", "run", "build"], packageDir);
}

async function packReleaseCandidate(packageDir: string, artifactDir: string): Promise<string> {
  const manifest = await readManifest(packageDir);
  const tarballName = `${manifest.name.replace(/^@/, "").replace(/\//g, "-")}-${manifest.version}.tgz`;

  await runCommand(["bun", "pm", "pack", "--destination", artifactDir], packageDir);

  return path.join(artifactDir, tarballName);
}

async function createFakeClaudeAgentTarball(artifactDir: string): Promise<string> {
  const packageDir = await mkdtemp(path.join(os.tmpdir(), "agents-js-fake-claude-agent-"));
  const binDir = path.join(packageDir, "bin");

  try {
    await mkdir(binDir, { recursive: true });
    await writeFile(
      path.join(packageDir, "package.json"),
      `${JSON.stringify(
        {
          name: "@agentclientprotocol/claude-agent-acp",
          version: "0.33.1",
          private: true,
          type: "module",
          bin: {
            "claude-agent-acp": "bin/cli.mjs",
          },
          files: ["bin", "package.json"],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(binDir, "cli.mjs"),
      "#!/usr/bin/env node\nconsole.log('fake claude-agent-acp');\n",
    );
    await chmod(path.join(binDir, "cli.mjs"), 0o755);
    return await packReleaseCandidate(packageDir, artifactDir);
  } finally {
    await rm(packageDir, { recursive: true, force: true });
  }
}

async function createFakeCodexAgentTarball(artifactDir: string): Promise<string> {
  const packageDir = await mkdtemp(path.join(os.tmpdir(), "agents-js-fake-codex-agent-"));
  const binDir = path.join(packageDir, "bin");

  try {
    await mkdir(binDir, { recursive: true });
    await writeFile(
      path.join(packageDir, "package.json"),
      `${JSON.stringify(
        {
          name: "@zed-industries/codex-acp",
          version: "0.11.1",
          private: true,
          type: "module",
          bin: {
            "codex-acp": "bin/cli.mjs",
          },
          files: ["bin", "package.json"],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(binDir, "cli.mjs"),
      "#!/usr/bin/env node\nconsole.log('fake codex-acp');\n",
    );
    await chmod(path.join(binDir, "cli.mjs"), 0o755);
    return await packReleaseCandidate(packageDir, artifactDir);
  } finally {
    await rm(packageDir, { recursive: true, force: true });
  }
}

async function readPackedManifest(tarballPath: string): Promise<Record<string, unknown>> {
  const manifest = await runCommand(["tar", "-xOf", tarballPath, "package/package.json"], repoRoot);
  return JSON.parse(manifest) as Record<string, unknown>;
}

function buildSmokeConsumerPackageJson(args: {
  cliTarball: string;
  fakeClaudeTarball: string;
  fakeCodexTarball: string;
  policyTarball: string;
  validationTarball: string;
  schemaUtilsTarball: string;
  acpTarball: string;
  acpHostTarball: string;
  a2aTarball: string;
  a2aClientTarball: string;
  gatewayRuntimeTarball: string;
}): SmokeConsumerPackageJson {
  return {
    name: "agents-js-cli-consumer-smoke",
    private: true,
    dependencies: {
      "@agents-js/cli": `file:${args.cliTarball}`,
      [claudeAgentPackageName]: `file:${args.fakeClaudeTarball}`,
      [codexAgentPackageName]: `file:${args.fakeCodexTarball}`,
    },
    overrides: {
      "@agents-js/policy": `file:${args.policyTarball}`,
      "@agents-js/validation": `file:${args.validationTarball}`,
      "@agents-js/schema-utils": `file:${args.schemaUtilsTarball}`,
      "@agents-js/acp": `file:${args.acpTarball}`,
      "@agents-js/acp-host": `file:${args.acpHostTarball}`,
      "@agents-js/a2a": `file:${args.a2aTarball}`,
      "@agents-js/a2a-client": `file:${args.a2aClientTarball}`,
      "@agents-js/gateway-runtime": `file:${args.gatewayRuntimeTarball}`,
    },
  };
}

async function verifyInstalledCli(tempDir: string): Promise<void> {
  const installedCliPath = path.join(tempDir, "node_modules", "@agents-js", "cli");
  const manifest = (await Bun.file(path.join(installedCliPath, "package.json")).json()) as {
    bin?: Record<string, string>;
  };
  if (manifest.bin?.["agents-js"] !== "dist/bin.mjs") {
    throw new Error('[cli-package-smoke] Expected installed CLI bin to point at "dist/bin.mjs".');
  }

  const distCliPath = path.join(installedCliPath, "dist", "bin.mjs");
  if (!(await Bun.file(distCliPath).exists())) {
    throw new Error("[cli-package-smoke] Expected dist/bin.mjs to exist in the installed package.");
  }

  const installedBinPath = path.join(tempDir, "node_modules", ".bin", "agents-js");
  const helpProc = Bun.spawn({
    cmd: [installedBinPath, "--help"],
    cwd: tempDir,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: process.env,
  });
  const helpStdout = await new Response(helpProc.stdout).text();
  const helpStderr = await new Response(helpProc.stderr).text();
  const helpExitCode = await helpProc.exited;

  const helpOutput =
    helpExitCode === 0
      ? helpStdout
      : (() => {
          throw new Error(
            [
              `[cli-package-smoke] Command failed (${helpExitCode}): ${installedBinPath} --help`,
              helpStdout.trim(),
              helpStderr.trim(),
            ]
              .filter(Boolean)
              .join("\n"),
          );
        })();

  if (!helpOutput.includes("agents-js")) {
    throw new Error("[cli-package-smoke] Installed CLI did not print help output.");
  }

  for (const [runtimeId, binName] of [
    ["claude", "claude-agent-acp"],
    ["codex", "codex-acp"],
  ] as const) {
    const resolveRuntimeScript = `
import path from "node:path";
import { getGatewayRuntimeDefinition, resolveGatewayRuntimeCommand } from "@agents-js/gateway-runtime";

const modulePath = path.join(process.cwd(), "node_modules", "@agents-js", "cli", "dist", "index.mjs");
const command = await resolveGatewayRuntimeCommand(getGatewayRuntimeDefinition("${runtimeId}"), {
  modulePath,
  resolver: {
    which() {
      return undefined;
    },
    async fileExists(filePath) {
      return Bun.file(filePath).exists();
    },
  },
});
console.log(command);
console.log(path.basename(command));
`;
    const resolvedOutput = (await runCommand(["bun", "-e", resolveRuntimeScript], tempDir))
      .trim()
      .split("\n");
    const resolvedCommand = resolvedOutput[0] ?? "";
    const resolvedBasename = resolvedOutput[1] ?? "";
    const expectedCommand = await realpath(path.join(tempDir, "node_modules", ".bin", binName));
    const normalizedResolvedCommand = await realpath(resolvedCommand);

    if (normalizedResolvedCommand !== expectedCommand) {
      throw new Error(
        `[cli-package-smoke] Expected installed CLI to resolve ${binName} at ${expectedCommand}, got ${normalizedResolvedCommand}.`,
      );
    }
    if (resolvedBasename !== binName) {
      throw new Error(
        `[cli-package-smoke] Installed CLI resolved an unexpected ${runtimeId} runtime executable.`,
      );
    }
  }
}

export async function main(): Promise<void> {
  const artifactDir = await mkdtemp(path.join(os.tmpdir(), "agents-js-cli-artifacts-"));
  const tempConsumerDir = await mkdtemp(path.join(os.tmpdir(), "agents-js-cli-consumer-"));

  try {
    await buildPackage(packageDirs.policy);
    await buildPackage(packageDirs.validation);
    await buildPackage(packageDirs.schemaUtils);
    await buildPackage(packageDirs.acp);
    await buildPackage(packageDirs.acpHost);
    await buildPackage(packageDirs.a2a);
    await buildPackage(packageDirs.a2aClient);
    await buildPackage(packageDirs.gatewayRuntime);
    await buildPackage(packageDirs.cli);

    const policyTarball = await packReleaseCandidate(packageDirs.policy, artifactDir);
    const validationTarball = await packReleaseCandidate(packageDirs.validation, artifactDir);
    const schemaUtilsTarball = await packReleaseCandidate(packageDirs.schemaUtils, artifactDir);
    const acpTarball = await packReleaseCandidate(packageDirs.acp, artifactDir);
    const acpHostTarball = await packReleaseCandidate(packageDirs.acpHost, artifactDir);
    const a2aTarball = await packReleaseCandidate(packageDirs.a2a, artifactDir);
    const a2aClientTarball = await packReleaseCandidate(packageDirs.a2aClient, artifactDir);
    const gatewayRuntimeTarball = await packReleaseCandidate(
      packageDirs.gatewayRuntime,
      artifactDir,
    );
    const cliTarball = await packReleaseCandidate(packageDirs.cli, artifactDir);
    const fakeClaudeTarball = await createFakeClaudeAgentTarball(artifactDir);
    const fakeCodexTarball = await createFakeCodexAgentTarball(artifactDir);

    const packedCliManifest = await readPackedManifest(cliTarball);
    const packedCliBin = (packedCliManifest.bin as Record<string, string> | undefined)?.[
      "agents-js"
    ];
    if (packedCliBin !== "dist/bin.mjs") {
      throw new Error(
        '[cli-package-smoke] Packed CLI manifest did not point "agents-js" at dist/bin.mjs.',
      );
    }

    const cliDependencies =
      (packedCliManifest.dependencies as Record<string, string> | undefined) ?? {};
    if (Object.values(cliDependencies).some((value) => value.startsWith("workspace:"))) {
      throw new Error(
        "[cli-package-smoke] Packed CLI manifest still contains workspace:* dependencies.",
      );
    }
    if (cliDependencies[claudeAgentPackageName] !== "0.33.1") {
      throw new Error(
        "[cli-package-smoke] Packed CLI manifest is missing the expected @agentclientprotocol/claude-agent-acp dependency.",
      );
    }
    if (cliDependencies[codexAgentPackageName] !== "0.14.0") {
      throw new Error(
        "[cli-package-smoke] Packed CLI manifest is missing the expected @zed-industries/codex-acp dependency.",
      );
    }

    const consumerPackageJson = buildSmokeConsumerPackageJson({
      cliTarball,
      fakeClaudeTarball,
      fakeCodexTarball,
      policyTarball,
      validationTarball,
      schemaUtilsTarball,
      acpTarball,
      acpHostTarball,
      a2aTarball,
      a2aClientTarball,
      gatewayRuntimeTarball,
    });
    await writeFile(
      path.join(tempConsumerDir, "package.json"),
      `${JSON.stringify(consumerPackageJson, null, 2)}\n`,
    );

    await runCommand(["npm", "install", "--quiet"], tempConsumerDir);
    await verifyInstalledCli(tempConsumerDir);

    console.log("[cli-package-smoke] packed and installed CLI verification passed");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(tempConsumerDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
