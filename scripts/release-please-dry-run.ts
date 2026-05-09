#!/usr/bin/env bun

// =============================================================================
// release-please-dry-run.ts
// =============================================================================
//
// WHY:
//   Catches release-please-config.json typos and JSONPath / schema regressions
//   BEFORE they hit main and silently break the release-please PR. The
//   release-please CLI wraps the same logic that release-please-action runs in
//   CI, so invoking it locally with --dry-run gives a high-fidelity smoke test.
//
//   release-please's failure mode is usually quiet: a malformed extra-files
//   entry just gets skipped, and you only notice when the next PR shows the
//   wrong package.json files updated. This script asserts the expected paths,
//   versions, and changelog sections appear in the config and (when a token
//   is available) in the dry-run output.
//
// WHAT it asserts (script exits non-zero if any fail):
//
//   Offline (always run, no token required):
//     A1. release-please-config.json AND .release-please-manifest.json
//         parse as valid JSON.
//     A2. .release-please-manifest.json has a root entry ".".
//     A3. The root component's extra-files block matches the live
//         publishable-package set discovered from packages/*: declared
//         and discovered counts are equal AND every packages/* directory
//         with `private: false` is covered, with no stale paths in
//         extra-files. (Drift detection — adding a publishable package
//         without an extra-files entry, or vice versa, fails the check.)
//     A4. changelog-sections maps `feat -> Added`, `fix -> Fixed`, and at
//         least one of {chore, ci, build, refactor, test, docs, style} to
//         `Internal` (proves the user-facing-first taxonomy is wired).
//     A5. Manifest seeds root at the same version recorded in root
//         package.json (single source of truth).
//
//   Online / live CLI (opt-in, set RELEASE_PLEASE_LIVE=1):
//     The release-please CLI fetches release-please-config.json and
//     .release-please-manifest.json from the REMOTE target branch (main)
//     via the GitHub API — not from the local checkout. That means a true
//     live dry-run can only validate config that has already been merged to
//     main. Pre-merge, the offline asserts above are the strongest check we
//     can run; a live run from a feature branch will fail with
//     "Missing required manifest config" because the file doesn't exist on
//     remote main yet.
//
//     Therefore the live invocation is gated behind RELEASE_PLEASE_LIVE=1
//     and is intended to run post-merge to confirm end-to-end behavior:
//
//       RELEASE_PLEASE_LIVE=1 bun run release:dry-run
//
//     When enabled, asserts:
//       B1. release-please CLI exits 0.
//       B2. CLI produces either a "would-open-PR" or "no-release-needed"
//           outcome (both prove the config parsed end-to-end).
//
//     Token sourcing for live mode: GITHUB_TOKEN env var, then
//     `gh auth token` fallback.
//
// HOW to extend:
//   - Add new asserts as objects with {ok, msg} pushed into the `results`
//     array. Pattern is uniform — read it once, mimic.
//   - To add coverage for a new section type (e.g. you map `security:` to a
//     new "Security" section), extend EXPECTED_SECTION_MAPPINGS below.
//   - To add a new publishable package: add the directory under packages/
//     with `"private": false`, then add the corresponding extra-files entry
//     in release-please-config.json. This script will detect drift between
//     the two via assert A3.
//
// HOW to run:
//   bun run release:dry-run
//   (or directly: bun scripts/release-please-dry-run.ts)
// =============================================================================

import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const configPath = path.join(repoRoot, "release-please-config.json");
const manifestPath = path.join(repoRoot, ".release-please-manifest.json");
const rootPackagePath = path.join(repoRoot, "package.json");
const packagesDir = path.join(repoRoot, "packages");

interface ExtraFilesEntry {
  type: string;
  path: string;
  jsonpath?: string;
}

interface ChangelogSection {
  type: string;
  section: string;
}

interface ReleasePleaseConfig {
  packages: Record<
    string,
    {
      "extra-files"?: Array<string | ExtraFilesEntry>;
    }
  >;
  "changelog-sections"?: ChangelogSection[];
}

interface ReleasePleaseManifest {
  [packagePath: string]: string;
}

interface AssertResult {
  ok: boolean;
  msg: string;
}

const EXPECTED_SECTION_MAPPINGS: Array<{ type: string; section: string }> = [
  { type: "feat", section: "Added" },
  { type: "fix", section: "Fixed" },
];

// At least ONE of these types must map to "Internal" — we don't require all,
// because the orchestrator may rebalance which conventional types are
// classified as internal vs user-facing.
const EXPECTED_INTERNAL_TYPES = ["chore", "ci", "build", "refactor", "test", "docs", "style"];

function fail(msg: string): never {
  console.error(`\n[release-please-dry-run] FAIL: ${msg}`);
  process.exit(1);
}

async function loadJson<T>(filePath: string, label: string): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    fail(`${label} not found at ${filePath}.`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    fail(`${label} is not valid JSON: ${(err as Error).message}`);
  }
}

function extractExtraFilePaths(config: ReleasePleaseConfig): string[] {
  const root = config.packages["."];
  if (!root) {
    fail(`release-please-config.json missing root package "."`);
  }
  const extras = root["extra-files"] ?? [];
  const paths: string[] = [];
  for (const entry of extras) {
    if (typeof entry === "string") {
      paths.push(entry);
    } else if (entry && typeof entry === "object" && typeof entry.path === "string") {
      paths.push(entry.path);
    }
  }
  return paths;
}

async function discoverPublishablePackagePaths(): Promise<string[]> {
  const dirs = await readdir(packagesDir, { withFileTypes: true });
  const result: string[] = [];
  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue;
    const pkgPath = path.join(packagesDir, dirent.name, "package.json");
    let raw: string;
    try {
      raw = await readFile(pkgPath, "utf8");
    } catch (err) {
      // ENOENT = directory has no package.json; not a publishable package.
      // Anything else (permissions, I/O error) is a real repo problem and
      // should fail the dry-run rather than silently dropping the dir from
      // the discovered set (which would mask drift, A3).
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      fail(`failed to read ${pkgPath}: ${(err as Error).message}`);
    }
    let manifest: { private?: boolean };
    try {
      manifest = JSON.parse(raw);
    } catch (err) {
      // Unparseable package.json is a real repo break; fail loudly.
      fail(`${pkgPath} is not valid JSON: ${(err as Error).message}`);
    }
    if (manifest.private === true) continue;
    result.push(`packages/${dirent.name}/package.json`);
  }
  return result.sort();
}

function resolveGithubToken(): string | null {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const gh = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  if (gh.status === 0) {
    const tok = gh.stdout?.trim();
    if (tok) return tok;
  }
  return null;
}

// Pin the CLI to a specific major so the dry-run's behavior doesn't drift
// from CI's release-please-action over time. Bump deliberately when
// release-please-action upgrades its bundled CLI.
const RELEASE_PLEASE_CLI_VERSION = "^17";

function runReleasePlease(token: string): { stdout: string; stderr: string; exitCode: number } {
  // Pass token via env (GH_TOKEN) rather than --token CLI arg so it doesn't
  // appear in `ps` output / shell history. release-please CLI honors
  // GH_TOKEN/GITHUB_TOKEN identically to the explicit flag.
  const result = spawnSync(
    "bunx",
    [
      `release-please@${RELEASE_PLEASE_CLI_VERSION}`,
      "release-pr",
      "--config-file",
      "release-please-config.json",
      "--manifest-file",
      ".release-please-manifest.json",
      "--target-branch",
      "main",
      "--dry-run",
      "--debug",
      "--repo-url",
      "jensbodal/agents-js",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0", GH_TOKEN: token, GITHUB_TOKEN: token },
      timeout: 240_000,
    },
  );
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

async function main(): Promise<void> {
  const config = await loadJson<ReleasePleaseConfig>(configPath, "release-please-config.json");
  const manifest = await loadJson<ReleasePleaseManifest>(
    manifestPath,
    ".release-please-manifest.json",
  );
  const rootPkg = await loadJson<{ version: string }>(rootPackagePath, "root package.json");

  const results: AssertResult[] = [];

  // A1: both config + manifest parsed as valid JSON. Recorded explicitly
  // (rather than relying on early-exit in loadJson) so the printed output
  // covers every assert documented in the header.
  results.push({
    ok: true,
    msg: `[A1] release-please-config.json + .release-please-manifest.json parse as JSON`,
  });

  // A2: manifest has root entry
  const manifestRoot = manifest["."];
  results.push({
    ok: !!manifestRoot,
    msg: `[A2] manifest has root entry ".": ${manifestRoot ?? "MISSING"}`,
  });

  // A3: extra-files match the publishable package set
  const declaredPaths = extractExtraFilePaths(config).sort();
  const discoveredPaths = await discoverPublishablePackagePaths();
  const missingFromConfig = discoveredPaths.filter((p) => !declaredPaths.includes(p));
  const extraInConfig = declaredPaths.filter((p) => !discoveredPaths.includes(p));

  results.push({
    ok: declaredPaths.length === discoveredPaths.length,
    msg:
      `[A3a] extra-files count matches publishable package count: ` +
      `declared=${declaredPaths.length}, discovered=${discoveredPaths.length}`,
  });
  results.push({
    ok: missingFromConfig.length === 0,
    msg:
      `[A3b] every publishable package is in extra-files: ` +
      (missingFromConfig.length === 0 ? "yes" : `MISSING ${missingFromConfig.join(", ")}`),
  });
  results.push({
    ok: extraInConfig.length === 0,
    msg:
      `[A3c] no stale paths in extra-files: ` +
      (extraInConfig.length === 0 ? "yes" : `STALE ${extraInConfig.join(", ")}`),
  });

  // A4: changelog-sections taxonomy
  const sections = config["changelog-sections"] ?? [];
  for (const expected of EXPECTED_SECTION_MAPPINGS) {
    const match = sections.find((s) => s.type === expected.type && s.section === expected.section);
    results.push({
      ok: !!match,
      msg:
        `[A4] changelog mapping ${expected.type} -> ${expected.section}: ` +
        (match ? "present" : "MISSING"),
    });
  }
  const internalMatch = sections.find(
    (s) => EXPECTED_INTERNAL_TYPES.includes(s.type) && s.section === "Internal",
  );
  results.push({
    ok: !!internalMatch,
    msg:
      `[A4] at least one of {${EXPECTED_INTERNAL_TYPES.join(",")}} -> Internal: ` +
      (internalMatch ? `present (${internalMatch.type} -> Internal)` : "MISSING"),
  });

  // A5: manifest version matches root package.json version
  results.push({
    ok: manifestRoot === rootPkg.version,
    msg: `[A5] manifest root version (${manifestRoot}) matches root package.json (${rootPkg.version})`,
  });

  // ---------------------------------------------------------------------------
  // Online checks (B*) — opt-in, post-merge only. release-please fetches
  // config from the remote target branch via API, so a feature branch can't
  // self-validate live. See header for the full explanation.
  // ---------------------------------------------------------------------------
  const live = process.env.RELEASE_PLEASE_LIVE === "1";
  const token = live ? resolveGithubToken() : null;
  if (!live) {
    console.log(
      "[release-please-dry-run] live CLI invocation skipped " +
        "(set RELEASE_PLEASE_LIVE=1 to enable; only meaningful post-merge).",
    );
  } else if (!token) {
    fail(
      "RELEASE_PLEASE_LIVE=1 set but no GITHUB_TOKEN found and `gh auth token` " +
        "failed. Set GITHUB_TOKEN or run `gh auth login` first.",
    );
  } else {
    console.log(`[release-please-dry-run] running release-please CLI...`);
    const { stdout, stderr, exitCode } = runReleasePlease(token);
    const combined = `${stdout}\n${stderr}`;

    results.push({
      ok: exitCode === 0,
      msg: `[B1] release-please CLI exit code: ${exitCode === 0 ? "0" : `${exitCode} (expected 0)`}`,
    });

    // B2: the CLI either prints "no release necessary" / "no candidate" /
    // similar (clean main, no qualifying commits since last tag) OR prints
    // a candidate PR. Both prove the config parsed end-to-end.
    const wouldOpenPr = /candidate|releasing|new version|Pull request|"version":/i.test(combined);
    const noReleaseNeeded = /no release necessary|nothing to release|no release-please/i.test(
      combined,
    );
    const ranClean = wouldOpenPr || noReleaseNeeded;
    results.push({
      ok: ranClean,
      msg:
        `[B2] CLI produced a recognizable release-please outcome: ` +
        (wouldOpenPr ? "would-open-PR" : noReleaseNeeded ? "no-release-needed" : "UNRECOGNIZED"),
    });

    if (!ranClean || exitCode !== 0) {
      console.error("\n--- release-please stdout (first 120 lines) ---");
      console.error(stdout.split("\n").slice(0, 120).join("\n"));
      console.error("\n--- release-please stderr (first 120 lines) ---");
      console.error(stderr.split("\n").slice(0, 120).join("\n"));
    }
  }

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------
  let allOk = true;
  for (const r of results) {
    const prefix = r.ok ? "  ok  " : "  FAIL";
    console.log(`${prefix}  ${r.msg}`);
    if (!r.ok) allOk = false;
  }

  if (!allOk) {
    console.error("\n[release-please-dry-run] one or more asserts failed.");
    process.exit(1);
  }

  console.log(`\n[release-please-dry-run] all ${results.length} asserts passed.`);
}

await main();
