import { join, relative } from "node:path";
import { PROFILE_DESCRIPTIONS, SNAPSHOT_COMMANDS, WEB_ALLOWLIST_SOURCES } from "./constants.ts";
import { normalizeText, sha256 } from "./hash.ts";
import type {
  CommandSnapshot,
  GenerateReportOptions,
  RepoComponent,
  ReportingDeps,
  ReportProfileId,
  RepoSnapshot,
  SourceSnapshot,
} from "./types.ts";

/**
 * Exact 40-char hex string (case-insensitive) — exact-shape parity with
 * the output of `git rev-parse HEAD`, which is what we are validating
 * upstream. The 40-char hex form is the canonical full SHA-1; pinning
 * the regex to that shape prevents accepting abbreviated SHAs (which
 * `git rev-parse --short` emits) or any other hex-ish string.
 *
 * Using a regex because the combined length+charset check is shorter
 * than two `every()` passes (one for length, one to verify each char is
 * hex), and reads as a single declarative spec rather than two
 * sequential predicates.
 */
const SHA1_HEX_PATTERN = /^[0-9a-f]{40}$/i;

export async function buildRepoSnapshot(
  options: GenerateReportOptions,
  deps: ReportingDeps,
): Promise<RepoSnapshot> {
  const gitSha = await resolveGitSha(options.repoRoot, deps);
  const repoName = await resolveRepoName(options.repoRoot, deps);
  const profileId = resolveProfileId(options.profileId, repoName);

  const [fileManifest, commands, sources] = await Promise.all([
    collectFileManifest(options.repoRoot, deps),
    collectCommandSnapshots(options.repoRoot, deps),
    collectSources(deps),
  ]);

  const components = await discoverComponents(options.repoRoot, fileManifest, deps);

  return {
    gitSha,
    repoName,
    fileManifest,
    commands,
    sources,
    components,
    profileId,
  };
}

async function resolveGitSha(repoRoot: string, deps: ReportingDeps): Promise<string> {
  const result = await deps.runCommand("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to resolve git SHA: ${normalizeText(result.stderr || result.stdout)}`);
  }

  const sha = normalizeText(result.stdout);
  if (!SHA1_HEX_PATTERN.test(sha)) {
    throw new Error(`Invalid git SHA returned: ${sha}`);
  }

  return sha;
}

async function resolveRepoName(repoRoot: string, deps: ReportingDeps): Promise<string> {
  const packagePath = join(repoRoot, "package.json");
  const content = await deps.readFile(packagePath);
  const parsed = JSON.parse(content) as { name?: string };
  if (typeof parsed.name === "string" && parsed.name.length > 0) {
    return parsed.name;
  }

  return relative(join(repoRoot, ".."), repoRoot) || "repository";
}

function resolveProfileId(
  explicit: ReportProfileId | undefined,
  repoName: string,
): ReportProfileId {
  if (explicit) {
    return explicit;
  }

  if (repoName.includes("agents-js")) {
    return "agents-js";
  }

  return "generic";
}

async function collectFileManifest(repoRoot: string, deps: ReportingDeps): Promise<string[]> {
  const args = ["--files", "-g", "!node_modules/**", "-g", "!_dot/reports/**"];
  const result = await deps.runCommand("rg", args, { cwd: repoRoot });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to collect file manifest: ${normalizeText(result.stderr || result.stdout)}`,
    );
  }

  return result.stdout
    .split("\n")
    .map((line) => normalizeText(line))
    .filter((line) => line.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

async function collectCommandSnapshots(
  repoRoot: string,
  deps: ReportingDeps,
): Promise<CommandSnapshot[]> {
  const snapshots: CommandSnapshot[] = [];

  for (const spec of SNAPSHOT_COMMANDS) {
    const [command, ...args] = spec.command;
    if (!command) {
      throw new Error(`Invalid snapshot command spec for ${spec.name}`);
    }
    const result = await deps.runCommand(command, args, { cwd: repoRoot });
    snapshots.push({
      name: spec.name,
      command: spec.command,
      stdout: normalizeText(result.stdout),
      stderr: normalizeText(result.stderr),
      exitCode: result.exitCode,
    });
  }

  return snapshots;
}

async function collectSources(deps: ReportingDeps): Promise<SourceSnapshot[]> {
  const snapshots: SourceSnapshot[] = [];

  for (const source of WEB_ALLOWLIST_SOURCES) {
    const content = await deps.fetchText(source.url);
    const normalizedContent = normalizeText(content);
    snapshots.push({
      sourceId: source.sourceId,
      url: source.url,
      sha256: sha256(normalizedContent),
      normalizedContent,
    });
  }

  return snapshots;
}

async function discoverComponents(
  repoRoot: string,
  fileManifest: string[],
  deps: ReportingDeps,
): Promise<RepoComponent[]> {
  const packageFiles = fileManifest
    .filter((path) => path.endsWith("package.json"))
    .filter((path) => !path.startsWith("node_modules/"))
    .sort((a, b) => a.localeCompare(b));

  const components: RepoComponent[] = [];

  for (const relativePath of packageFiles) {
    try {
      const absolutePath = join(repoRoot, relativePath);
      const content = await deps.readFile(absolutePath);
      const parsed = JSON.parse(content) as { name?: string };
      const name =
        typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : relativePath;
      const id = sha256(`${relativePath}:${name}`).slice(0, 12);
      components.push({
        id,
        path: relativePath,
        name,
      });
    } catch {
      // Skip unparseable package files to keep snapshot collection resilient.
    }
  }

  return components.sort((a, b) => a.path.localeCompare(b.path));
}

export function getProfileDescription(profileId: ReportProfileId): string {
  return PROFILE_DESCRIPTIONS[profileId];
}
