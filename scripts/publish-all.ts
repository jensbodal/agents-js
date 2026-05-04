#!/usr/bin/env bun
/**
 * scripts/publish-all.ts
 *
 * Publish every `@agents-js/*` package to the configured Nexus registry in
 * dependency order. Defaults to `--dry-run` so it cannot accidentally publish
 * during testing — pass `--no-dry-run` to actually run `npm publish`.
 *
 * Usage:
 *   bun run scripts/publish-all.ts                       # dry-run all publishable packages
 *   bun run scripts/publish-all.ts --no-dry-run          # actually publish all
 *   bun run scripts/publish-all.ts --package acp         # only @agents-js/acp
 *   bun run scripts/publish-all.ts --package acp \
 *                                  --package acp-host    # subset (repeatable)
 *   bun run scripts/publish-all.ts --skip-build          # publish without rebuilding
 *   bun run scripts/publish-all.ts --no-dry-run --tag beta  # publish under dist-tag "beta"
 *
 * For prerelease versions (e.g. `0.2.0-beta-2`) npm requires an explicit
 * `--tag` flag; the script auto-infers one from the manifest version (e.g.
 * `beta`, `alpha`, `rc`) if `--tag` is not supplied. Pass `--tag` explicitly
 * to override. Stable versions default to npm's `latest`.
 *
 * The script reads `.npmrc` from the repo root for registry configuration; no
 * auth is handled here. Run from a checkout with the appropriate `.npmrc` in
 * place.
 */

import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { PUBLISH_REGISTRY_ENV, resolvePublishRegistry } from "./release-config.ts";
import { auditReleaseSurface } from "./release-preflight.ts";

const repoRoot = path.resolve(import.meta.dir, "..");
const packagesRoot = path.join(repoRoot, "packages");

interface PackageManifest {
  name: string;
  version: string;
  private?: boolean;
  publishConfig?: {
    registry?: string;
    access?: string;
  };
}

interface NpmPackDryRunEntry {
  entryCount: number;
  files: Array<{ path: string }>;
  filename: string;
  name: string;
  version: string;
}

interface CliOptions {
  dryRun: boolean;
  skipBuild: boolean;
  packages: string[];
  tag?: string;
}

interface PackageResult {
  dirName: string;
  manifestName: string;
  version: string;
  status: "published" | "would-publish" | "skipped";
  detail?: string;
}

class PublishError extends Error {
  constructor(
    message: string,
    public readonly dirName: string,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

function parseCliArgs(argv: string[]): CliOptions {
  let dryRun = true;
  let skipBuild = false;
  let tag: string | undefined;
  const packages: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run":
        dryRun = true;
        break;
      case "--no-dry-run":
        dryRun = false;
        break;
      case "--skip-build":
        skipBuild = true;
        break;
      case "--tag": {
        const value = argv[i + 1];
        if (!value) {
          throw new Error(`Missing value for "--tag".`);
        }
        tag = value;
        i += 1;
        break;
      }
      case "--package": {
        const value = argv[i + 1];
        if (!value) {
          throw new Error(`Missing value for "--package".`);
        }
        packages.push(value);
        i += 1;
        break;
      }
      case "--help":
      case "-h":
        printUsageAndExit(0);
        break;
      default:
        if (arg.startsWith("--package=")) {
          const value = arg.slice("--package=".length);
          packages.push(value);
          break;
        }
        if (arg.startsWith("--tag=")) {
          tag = arg.slice("--tag=".length);
          break;
        }
        throw new Error(`Unknown argument "${arg}". See --help for supported flags.`);
    }
  }

  return { dryRun, skipBuild, packages, tag };
}

/**
 * Infer a sensible dist-tag from a semver version string.
 *
 * - `0.2.0-beta-2` → `"beta"`
 * - `0.2.0-alpha.1` → `"alpha"`
 * - `0.2.0-rc.3` → `"rc"`
 * - `1.0.0` → `undefined` (npm defaults to `latest`)
 *
 * npm requires an explicit dist-tag for any prerelease version (anything with
 * a `-` suffix in the semver spec). This helper avoids a hard-coded policy
 * while still matching the conventional identifiers the repo uses.
 *
 * **Registry caveat:** Sonatype Nexus does NOT persist npm dist-tags.
 * `npm view <pkg> dist-tags.beta` returns `none` even after
 * `npm publish --tag beta` succeeds. Consumers must pin exact versions
 * (for example, `"0.2.0-beta-N"`) rather than rely on floating tag resolution.
 * This is a registry-side limitation, not a script defect.
 */
export function inferDistTag(version: string): string | undefined {
  const prereleaseIdx = version.indexOf("-");
  if (prereleaseIdx === -1) {
    return undefined;
  }
  const prereleaseFragment = version.slice(prereleaseIdx + 1);
  const identifier = prereleaseFragment.split(/[.\-+]/)[0];
  return identifier || undefined;
}

function printUsageAndExit(code: number): never {
  const usage = `Usage: bun run scripts/publish-all.ts [options]

Options:
  --dry-run            Print what would happen without publishing (default).
  --no-dry-run         Actually publish (the safety override).
  --package <name>     Only publish the named package. Repeatable.
                       Package names are derived from publishable workspace directories.
  --tag <name>         Override the npm dist-tag for every package. If
                       omitted, the script auto-infers one from the package
                       version (e.g. "beta" for "0.2.0-beta-2"). Stable
                       versions default to npm's "latest".
  --skip-build         Skip "bun run build" before publishing.
  -h, --help           Show this message.
`;
  console.log(usage);
  process.exit(code);
}

async function readManifest(packageDir: string): Promise<PackageManifest> {
  const manifestPath = path.join(packageDir, "package.json");
  const file = Bun.file(manifestPath);
  if (!(await file.exists())) {
    throw new Error(`Missing package.json at ${manifestPath}`);
  }
  return (await file.json()) as PackageManifest;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function isNonEmptyDir(target: string): Promise<boolean> {
  try {
    const info = await stat(target);
    if (!info.isDirectory()) return false;
    const entries = await readdir(target);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function buildPackage(packageDir: string, dirName: string): Promise<void> {
  const proc = Bun.spawn(["bun", "run", "build"], {
    cwd: packageDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    throw new PublishError(
      `bun run build failed (exit ${exitCode}) for ${dirName}\n${detail}`,
      dirName,
    );
  }
}

async function verifyPackDryRun(
  packageDir: string,
  dirName: string,
  manifest: PackageManifest,
): Promise<void> {
  const proc = Bun.spawn(["npm", "pack", "--json", "--dry-run"], {
    cwd: packageDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    throw new PublishError(
      `npm pack --dry-run failed (exit ${exitCode}) for ${dirName}\n${detail}`,
      dirName,
    );
  }

  let result: NpmPackDryRunEntry | undefined;
  try {
    result = (JSON.parse(stdout) as NpmPackDryRunEntry[])[0];
  } catch (error) {
    throw new PublishError(
      `Could not parse npm pack --dry-run output for ${dirName}: ${(error as Error).message}`,
      dirName,
    );
  }

  if (!result) {
    throw new PublishError(`npm pack --dry-run produced no output for ${dirName}`, dirName);
  }
  if (result.name !== manifest.name || result.version !== manifest.version) {
    throw new PublishError(
      `npm pack --dry-run metadata mismatch for ${dirName}: expected ${manifest.name}@${manifest.version}, got ${result.name}@${result.version}`,
      dirName,
    );
  }
  if (result.entryCount <= 0) {
    throw new PublishError(`npm pack --dry-run produced an empty tarball for ${dirName}`, dirName);
  }
  if (!result.files.some((file) => file.path.startsWith("dist/"))) {
    throw new PublishError(
      `npm pack --dry-run for ${dirName} did not include any dist/ files`,
      dirName,
    );
  }
}

async function publishPackage(
  packageDir: string,
  dirName: string,
  tag: string | undefined,
  registry: string,
): Promise<void> {
  const args = ["publish", "--registry", registry];
  if (tag) {
    args.push("--tag", tag);
  }
  const proc = Bun.spawn(["npm", ...args], {
    cwd: packageDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    throw new PublishError(
      `npm publish failed (exit ${exitCode}) for ${dirName}\n${detail}`,
      dirName,
    );
  }
  const tail = stdout.trim().split("\n").slice(-3).join("\n");
  if (tail) {
    console.log(indent(tail));
  }
}

function indent(text: string, prefix = "    "): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function formatHeader(
  index: number,
  total: number,
  dirName: string,
  manifest: PackageManifest,
): string {
  return `\n[${index}/${total}] ${manifest.name}@${manifest.version}  (packages/${dirName})`;
}

async function processPackage(
  dirName: string,
  options: CliOptions,
  index: number,
  total: number,
  registry: string,
): Promise<PackageResult> {
  const packageDir = path.join(packagesRoot, dirName);

  if (!(await pathExists(packageDir))) {
    throw new PublishError(`Package directory not found: ${packageDir}`, dirName);
  }

  const manifest = await readManifest(packageDir);
  console.log(formatHeader(index, total, dirName, manifest));

  if (manifest.private === true) {
    console.log("    private: true — skipping");
    return {
      dirName,
      manifestName: manifest.name,
      version: manifest.version,
      status: "skipped",
      detail: "private package",
    };
  }

  if (options.skipBuild) {
    console.log("    skip build (--skip-build)");
  } else {
    console.log("    build: bun run build");
    await buildPackage(packageDir, dirName);
  }

  const distDir = path.join(packageDir, "dist");
  if (!(await isNonEmptyDir(distDir))) {
    throw new PublishError(
      `dist/ is missing or empty for ${dirName} (looked at ${distDir}). ` +
        `Run without --skip-build or investigate the build output.`,
      dirName,
    );
  }
  console.log("    verify: dist/ present");
  console.log("    verify: npm pack --dry-run");
  await verifyPackDryRun(packageDir, dirName, manifest);

  const effectiveTag = options.tag ?? inferDistTag(manifest.version);
  const tagDescription = effectiveTag ? ` --tag ${effectiveTag}` : "";
  const registryDescription = ` --registry ${registry}`;

  if (options.dryRun) {
    console.log(
      `    dry-run: would run "npm publish${registryDescription}${tagDescription}" in packages/${dirName} ` +
        `(${manifest.name}@${manifest.version})`,
    );
    return {
      dirName,
      manifestName: manifest.name,
      version: manifest.version,
      status: "would-publish",
    };
  }

  console.log(`    publish: npm publish${registryDescription}${tagDescription}`);
  await publishPackage(packageDir, dirName, effectiveTag, registry);
  return {
    dirName,
    manifestName: manifest.name,
    version: manifest.version,
    status: "published",
  };
}

function printSummary(results: PackageResult[], options: CliOptions): void {
  console.log("\n----- summary -----");
  for (const result of results) {
    const tag =
      result.status === "published"
        ? "PUBLISHED"
        : result.status === "would-publish"
          ? "DRY-RUN"
          : "SKIPPED";
    const detail = result.detail ? `  (${result.detail})` : "";
    console.log(`  [${tag}] ${result.manifestName}@${result.version}${detail}`);
  }
  const counts = results.reduce(
    (acc, r) => {
      acc[r.status] += 1;
      return acc;
    },
    { published: 0, "would-publish": 0, skipped: 0 } as Record<PackageResult["status"], number>,
  );
  console.log(
    `\n${results.length} package(s) processed: ` +
      `${counts.published} published, ${counts["would-publish"]} dry-run, ${counts.skipped} skipped` +
      (options.dryRun ? "  (dry-run mode — pass --no-dry-run to publish)" : ""),
  );
}

async function main(): Promise<void> {
  // Defense in depth: npm gives NPM_CONFIG_REGISTRY (env var) precedence over
  // publishConfig.registry in package.json. A developer with that env var set
  // for unrelated tooling would silently publish @agents-js/* to the wrong
  // registry. Fail fast before doing anything else.
  if (process.env.NPM_CONFIG_REGISTRY || process.env.npm_config_registry) {
    console.error(
      "ERROR: NPM_CONFIG_REGISTRY is set in the environment. This overrides " +
        "publishConfig.registry in package.json and could publish to the wrong " +
        "registry. Unset it before running publish-all.ts.",
    );
    process.exit(2);
  }

  let options: CliOptions;
  try {
    options = parseCliArgs(Bun.argv.slice(2));
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    printUsageAndExit(2);
  }

  const audit = await auditReleaseSurface({
    requireNpmrc: !options.dryRun,
    repoRoot,
  });
  if (audit.issues.length > 0) {
    console.error("publish-all: release preflight failed:");
    for (const issue of audit.issues) {
      console.error(`- ${issue}`);
    }
    process.exit(1);
  }

  // In dry-run we still need *some* --registry flag to produce a realistic
  // rehearsal. Fall back to a placeholder when the env var is unset.
  const registry =
    resolvePublishRegistry() ?? (options.dryRun ? "https://registry.invalid/" : null);
  if (registry === null) {
    console.error(
      `publish-all: ${PUBLISH_REGISTRY_ENV} is not set. Export the target npm registry URL before publishing (or pass --dry-run to rehearse).`,
    );
    process.exit(2);
  }

  const knownPackages = audit.publishOrder;
  const unknownPackages = options.packages.filter((pkg) => !knownPackages.includes(pkg));
  if (unknownPackages.length > 0) {
    console.error(
      `publish-all: unknown package selection(s): ${unknownPackages.join(", ")}. Known packages: ${knownPackages.join(", ")}`,
    );
    process.exit(2);
  }

  const targets =
    options.packages.length > 0
      ? knownPackages.filter((pkg) => options.packages.includes(pkg))
      : knownPackages;

  console.log(
    `publish-all: ${targets.length} package(s), ` +
      `mode=${options.dryRun ? "dry-run" : "PUBLISH"}` +
      `${options.skipBuild ? ", skip-build" : ""}`,
  );

  const results: PackageResult[] = [];
  for (let i = 0; i < targets.length; i += 1) {
    const dirName = targets[i];
    try {
      const result = await processPackage(dirName, options, i + 1, targets.length, registry);
      results.push(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\nFAILED in packages/${dirName}: ${message}`);
      printSummary(results, options);
      process.exit(1);
    }
  }

  printSummary(results, options);
}

if (import.meta.main) {
  await main();
}
