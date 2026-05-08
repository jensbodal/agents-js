#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { listGatewayRuntimeIds } from "@agents-js/gateway-runtime";
import { computePublishOrder, readPublishablePackages } from "./release-preflight.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Diátaxis frontmatter governance (J-2)
// ─────────────────────────────────────────────────────────────────────────────
// Every page in `docs/.manifest.json#handAuthoredPages` must carry a
// `diataxis:` frontmatter tag classifying its purpose. Reference-tagged
// pages must transclude generated content (via `!!!include(...)!!!` or
// `<<<`) unless they are temporarily allowlisted under
// `pendingExtraction` while the corresponding extraction port
// is in flight. The `_generated/README.md` index page is the one structural
// exemption (it documents `_generated/`; it does not transclude from it).
const VALID_DIATAXIS_TAGS = new Set(["tutorial", "howto", "reference", "explanation", "landing"]);

interface DocsManifest {
  handAuthoredPages: string[];
  referenceIndexExempt?: string[];
  /**
   * Single source of truth for "extraction is deferred." Two kinds of entries:
   *
   *   - Page-level (no `section`): a `diataxis: reference` page that doesn't
   *     yet contain an include directive. J-2's include-or-allowlist gate
   *     consults this set; the page is allowlisted until `blockedBy` lands.
   *
   *   - Section-level (`section` set): a specific section within an
   *     otherwise non-reference page that's tracked as deferred. These are
   *     informational at the J-2 level (they don't grant any exemption);
   *     the matching `<!-- pending-extraction: <section> -->` HTML comment
   *     in the page is the discoverable breadcrumb. Cross-validation
   *     between the manifest and the breadcrumbs is enforced by
   *     `collectPendingExtractionBreadcrumbIssues`.
   */
  pendingExtraction?: PendingExtractionEntry[];
}

interface PendingExtractionEntry {
  page: string;
  /** Optional: when set, the entry refers to a section, not the whole page. */
  section?: string;
  blockedBy: string;
  /** Optional human-readable description of when this is unblocked. */
  unblockCriterion?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ts-morph wrapper boundary
// ─────────────────────────────────────────────────────────────────────────────
// `ts-morph` is a heavy dependency confined to a single file so the dep blast
// radius for renames or version bumps stays bounded. Anything else under
// `scripts/` that needs ts-morph capability must consume them through the
// wrapper module's exported helpers.
const TS_MORPH_ALLOWED_PATH = "scripts/lib/package-introspection.ts";

// Canonical curated harness list derived from the gateway-runtime registry —
// the same source that drives env-key policy in acp-host. Adding or retiring
// a harness is a single edit in `packages/gateway-runtime/src/runtimes.ts`;
// Rule A in this script enforces the docs mirror that invariant.
const CURATED_HARNESSES = listGatewayRuntimeIds();

// Package names captured by the @agents-js/* regex scan that are intentionally
// not real workspace packages (e.g., illustrative placeholders). Add entries
// here only with a comment explaining the exclusion reason.
const PACKAGE_REF_EXCLUSIONS = new Set<string>();

interface PackageManifest {
  name: string;
  private?: boolean;
  version: string;
}

export interface FileExpectation {
  contains?: string[];
  forbids?: (string | RegExp)[];
  optional?: boolean;
  path: string;
}

interface TextFile {
  content: string;
  path: string;
}

interface GraphPackage {
  name?: unknown;
}

interface DependencyGraph {
  packages?: GraphPackage[];
}

const repoRoot = path.resolve(import.meta.dir, "..");

// Publicly-published docs hostname. Override via env for forks / mirrors;
// default is the project's canonical site.
const docsHostname = process.env.AGENTS_JS_DOCS_HOSTNAME?.trim() || "agents-js.bodal.dev";
const docsUrl = `https://${docsHostname}/`;
const launcherRuntimeCommand = "bun run dev --runtime claude";
const browserSmokeCommand = "bun run browser:smoke";
const liveBrowserCommand = "bun run e2e:web:live -- --runtime claude";
export const REMOVED_DOC_PATHS = [
  "docs/protocol-alignment.md",
  "docs/runtime-matrix.md",
  "docs/contribute.md",
  "docs/release-checklist.md",
  "docs/cli.md",
  "docs/acp-host.md",
] as const;

const providerHostSourcePatterns: readonly RegExp[] = [
  /https:\/\/github\.[^/\s]+\/[^/\s]+\/agents-js\b[^\s)\]}"]*/g,
  /git\+https:\/\/github\.[^/\s]+\/[^/\s]+\/agents-js\.git/g,
];

const providerAuthorityPatterns: readonly RegExp[] = [
  /\bGitHub Actions\b/g,
  /\bCI\/CD source of truth:\s*GitHub\b/g,
];

const handAuthoredStatusPatterns: readonly { label: string; pattern: RegExp }[] = [
  { label: "Last verified SHA/status prose", pattern: /\bLast verified\b/g },
  {
    label: "exact current beta version prose",
    pattern: /\bcurrently `0\.2\.0-beta-\d+`\b/g,
  },
  {
    label: "hand-authored package count prose",
    pattern: /\b(?:\d+ packages|\d+ publishable packages|Publish all \d+ packages)\b/g,
  },
  {
    label: "hand-authored package-count summary",
    pattern: /\b\d+ packages\s+—\s+\d+ publishable\b/g,
  },
];

// Bun is the workspace's *internal* toolchain (lockfile, mise pin, scripts).
// Consumers install via `npm i -g @agents-js/cli` or `bunx`; nothing forces
// them onto Bun. Framing the project as a "Bun toolkit" wrongly implies
// otherwise. Likewise, this repo treats `@agents-js/cli` as published — any
// "until it's published / not yet on npm / from a clone instead" hedging is
// stale wording and must be removed before docs ship. README is the canonical
// positioning source; these forbid-patterns enforce the no-regression rule.
const userFacingForbiddenPhrases: readonly { label: string; pattern: RegExp }[] = [
  { label: "consumer-facing 'Bun toolkit' framing", pattern: /\bBun toolkit\b/gi },
  { label: "consumer-facing 'typed Bun' framing", pattern: /\btyped Bun\b/gi },
  // Backtick-tolerant: the original docs/index.md hedge wrote
  // "Until `@agents-js/cli` is published". `[^.\n]{0,40}` keeps the match
  // inside one sentence while allowing for code-fence punctuation.
  { label: "publication hedge", pattern: /\bUntil[^.\n]{0,40}is published\b/gi },
  { label: "publication hedge", pattern: /\bpublished to public npm\b/gi },
  { label: "publication hedge", pattern: /\bnot yet published\b/gi },
  { label: "publication hedge", pattern: /\bnot yet on npm\b/gi },
  { label: "publication hedge", pattern: /\bonce published\b/gi },
  { label: "publication hedge", pattern: /\bwhen published\b/gi },
  { label: "publication hedge", pattern: /\bwill be published\b/gi },
  { label: "publication hedge", pattern: /\bpre-publication\b/gi },
  { label: "publication hedge", pattern: /\bpending publication\b/gi },
  {
    label: "publication hedge",
    pattern: /from a clone via the full-stack track instead/gi,
  },
];

// Files where editorial drift in positioning prose actually reaches readers.
// Contributor-facing files (AGENTS.md, CONTRIBUTING.md, docs/develop/**) are
// exempt from these phrase rules — release runbooks may legitimately discuss
// publication status.
const contributorFacingPaths = new Set<string>(["AGENTS.md", "CONTRIBUTING.md"]);
const contributorFacingPrefixes: readonly string[] = ["docs/develop/"];

function isContributorFacingPath(filePath: string): boolean {
  if (contributorFacingPaths.has(filePath)) return true;
  return contributorFacingPrefixes.some((prefix) => filePath.startsWith(prefix));
}

// README is the canonical positioning source; docs/index.md is derived. Both
// are required to contain this marker via the `contains` expectation list
// below.
export const CANONICAL_POSITIONING_MARKER = "A TypeScript library tying together";

const generatedDocsPaths = new Set(["docs/llms.txt", "docs/llms-full.txt"]);

// Calculated machine-readable outputs are allowed to carry exact counts.
const generatedMachineReadablePrefixes = ["docs/public/", "docs/api/"] as const;

const ciConfigPrefixes = [".github/"] as const;

async function readText(relativePath: string, root = repoRoot): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

async function readPackageManifests(root = repoRoot): Promise<PackageManifest[]> {
  const scopes = ["packages", "extras"] as const;
  const collected = await Promise.all(
    scopes.map(async (scope) => {
      const scopeDir = path.join(root, scope);
      const dirEntries = await readdir(scopeDir, { withFileTypes: true });
      const manifests = await Promise.all(
        dirEntries
          .filter((entry) => entry.isDirectory())
          .map(async (entry): Promise<PackageManifest | undefined> => {
            const manifestPath = path.join(scopeDir, entry.name, "package.json");
            // Skip directories with no manifest — package relocations can leave
            // behind empty parent dirs (cached node_modules / dist) that readdir
            // surfaces but readFile would error on.
            try {
              return JSON.parse(await readFile(manifestPath, "utf8")) as PackageManifest;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return undefined;
              }
              throw error;
            }
          }),
      );
      return manifests.filter((manifest): manifest is PackageManifest => manifest !== undefined);
    }),
  );

  return collected.flat().filter((manifest) => manifest.private !== true);
}

async function readWorkspaceManifestNames(root = repoRoot): Promise<string[]> {
  const names: string[] = [];
  const collectFromDir = async (dir: string) => {
    try {
      const manifest = JSON.parse(
        await readFile(path.join(dir, "package.json"), "utf8"),
      ) as PackageManifest;
      if (typeof manifest.name === "string" && manifest.name.length > 0) {
        names.push(manifest.name);
      }
    } catch {}
  };
  for (const scope of ["packages", "apps", "extras"] as const) {
    const scopeRoot = path.join(root, scope);
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(scopeRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await collectFromDir(path.join(scopeRoot, entry.name));
    }
  }
  // Explicit single-path workspace entries from root package.json
  // (e.g. tests/trial-agent — declared as a workspace but not under
  // a glob-scanned scope).
  await collectFromDir(path.join(root, "tests", "trial-agent"));
  return names.sort();
}

async function listFilesRecursive(root: string, relativeRoot: string): Promise<string[]> {
  const absoluteRoot = path.join(root, relativeRoot);
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(absoluteRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(root, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

async function readExistingScanFiles(root = repoRoot): Promise<TextFile[]> {
  const docsFiles = (await listFilesRecursive(root, "docs")).filter((filePath) => {
    if (generatedMachineReadablePrefixes.some((prefix) => filePath.startsWith(prefix))) {
      return false;
    }
    return /\.(?:md|txt)$/.test(filePath);
  });
  const githookFiles = (await listFilesRecursive(root, ".githooks")).filter((filePath) =>
    /(?:pre-commit|pre-push)$/.test(filePath),
  );
  const packageManifestFiles = [
    "package.json",
    ...(await listFilesRecursive(root, "packages")).filter((filePath) =>
      filePath.endsWith("/package.json"),
    ),
    ...(await listFilesRecursive(root, "apps")).filter((filePath) =>
      filePath.endsWith("/package.json"),
    ),
    ...(await listFilesRecursive(root, "extras")).filter((filePath) =>
      filePath.endsWith("/package.json"),
    ),
  ];
  const scriptFiles = ["scripts/ci-container.ts", "scripts/publish-all.ts"];
  const explicitFiles = ["README.md", ".npmrc"];

  const uniquePaths = [
    ...new Set([
      ...explicitFiles,
      ...docsFiles,
      ...githookFiles,
      ...packageManifestFiles,
      ...scriptFiles,
    ]),
  ].filter((filePath) => !ciConfigPrefixes.some((prefix) => filePath.startsWith(prefix)));

  const files: TextFile[] = [];
  for (const filePath of uniquePaths) {
    try {
      files.push({ path: filePath, content: await readText(filePath, root) });
    } catch {}
  }
  return files;
}

function resetPattern(pattern: RegExp): RegExp {
  pattern.lastIndex = 0;
  return pattern;
}

function collectPatternMatches(content: string, pattern: RegExp): string[] {
  const matches = content.match(resetPattern(pattern));
  return matches ? [...new Set(matches)] : [];
}

function isGeneratedMachineReadablePath(filePath: string): boolean {
  return generatedMachineReadablePrefixes.some((prefix) => filePath.startsWith(prefix));
}

export function collectProviderHostReferenceIssues(files: readonly TextFile[]): string[] {
  const errors: string[] = [];
  for (const file of files) {
    if (ciConfigPrefixes.some((prefix) => file.path.startsWith(prefix))) continue;
    for (const pattern of providerHostSourcePatterns) {
      for (const match of collectPatternMatches(file.content, pattern)) {
        errors.push(`${file.path}: contains provider-host source URL: ${match}`);
      }
    }
    for (const pattern of providerAuthorityPatterns) {
      for (const match of collectPatternMatches(file.content, pattern)) {
        errors.push(`${file.path}: treats a CI provider as authoritative content: ${match}`);
      }
    }
  }
  return errors;
}

export function collectGraphPackageIssues(
  manifestPackageNames: readonly string[],
  graphPackageNames: readonly string[],
): string[] {
  const expected = [...new Set(manifestPackageNames)].sort();
  const actual = [...new Set(graphPackageNames)].sort();
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((name) => !actualSet.has(name));
  const extra = actual.filter((name) => !expectedSet.has(name));
  const errors: string[] = [];
  if (missing.length > 0) {
    errors.push(`docs/public/graph.json is missing workspace packages: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    errors.push(`docs/public/graph.json contains non-workspace packages: ${extra.join(", ")}`);
  }
  return errors;
}

export function collectRemovedDocPathIssues(files: readonly TextFile[]): string[] {
  const errors: string[] = [];
  for (const file of files) {
    for (const retiredPath of REMOVED_DOC_PATHS) {
      if (file.content.includes(retiredPath)) {
        errors.push(`${file.path}: references retired documentation path: ${retiredPath}`);
      }
    }
  }
  return errors;
}

function collectLabeledPatternIssues(
  files: readonly TextFile[],
  patterns: readonly { label: string; pattern: RegExp }[],
  options: { skip?: (filePath: string) => boolean } = {},
): string[] {
  const errors: string[] = [];
  for (const file of files) {
    if (isGeneratedMachineReadablePath(file.path)) continue;
    if (options.skip?.(file.path)) continue;
    const isGeneratedDoc = generatedDocsPaths.has(file.path);
    for (const { label, pattern } of patterns) {
      for (const match of collectPatternMatches(file.content, pattern)) {
        if (isGeneratedDoc) {
          errors.push(`${file.path}: generated docs bundle still carries ${label}: ${match}`);
        } else {
          errors.push(`${file.path}: contains ${label}: ${match}`);
        }
      }
    }
  }
  return errors;
}

function collectHandAuthoredStatusIssues(files: readonly TextFile[]): string[] {
  return collectLabeledPatternIssues(files, handAuthoredStatusPatterns);
}

export function collectUserFacingForbiddenIssues(files: readonly TextFile[]): string[] {
  return collectLabeledPatternIssues(files, userFacingForbiddenPhrases, {
    skip: isContributorFacingPath,
  });
}

async function readGraphPackageNames(root = repoRoot): Promise<string[]> {
  const graph = JSON.parse(await readText("docs/public/graph.json", root)) as DependencyGraph;
  if (!Array.isArray(graph.packages)) {
    return [];
  }
  return graph.packages
    .map((pkg) => pkg.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0)
    .sort();
}

function ensureIncludes(
  content: string,
  filePath: string,
  values: string[],
  errors: string[],
): void {
  for (const value of values) {
    if (!content.includes(value)) {
      errors.push(`${filePath}: missing required text: ${value}`);
    }
  }
}

function ensureForbids(
  content: string,
  filePath: string,
  values: (string | RegExp)[],
  errors: string[],
): void {
  for (const value of values) {
    const matched = typeof value === "string" ? content.includes(value) : value.test(content);
    if (matched) {
      errors.push(
        `${filePath}: contains forbidden text: ${
          typeof value === "string" ? value : value.toString()
        }`,
      );
    }
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export async function collectFrontmatterTagIssues(
  manifest: DocsManifest,
  read: (relativePath: string) => Promise<string>,
): Promise<string[]> {
  const errors: string[] = [];
  const exempt = new Set(manifest.referenceIndexExempt ?? []);
  // Page-level entries (no `section` field) are the J-2 transition allowlist.
  // Section-level entries are tracked elsewhere (HTML breadcrumbs) and do
  // not grant an include-directive exemption.
  const pageLevelPending = new Map(
    (manifest.pendingExtraction ?? [])
      .filter((entry) => entry.section === undefined)
      .map((entry) => [entry.page, entry.blockedBy]),
  );

  // Every entry must reference a real hand-authored page. A typo here would
  // otherwise let a real reference page slip through the include-directive
  // gate without anyone noticing.
  const handAuthored = new Set(manifest.handAuthoredPages);
  for (const entry of manifest.pendingExtraction ?? []) {
    if (!handAuthored.has(entry.page)) {
      errors.push(
        `docs/.manifest.json: pendingExtraction lists "${entry.page}" (blocked by ${entry.blockedBy}) but it is not in handAuthoredPages`,
      );
    }
  }

  for (const page of manifest.handAuthoredPages) {
    let content: string;
    try {
      content = await read(`docs/${page}`);
    } catch {
      errors.push(
        `docs/${page}: listed in manifest.handAuthoredPages but file does not exist or is unreadable`,
      );
      continue;
    }

    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      errors.push(`docs/${page}: missing frontmatter (must include a 'diataxis:' tag)`);
      continue;
    }
    const tagMatch = frontmatterMatch[1].match(/^diataxis:\s*(\S+)\s*$/m);
    if (!tagMatch) {
      errors.push(
        `docs/${page}: frontmatter missing 'diataxis:' tag (one of ${[...VALID_DIATAXIS_TAGS].sort().join(", ")})`,
      );
      continue;
    }
    const tag = tagMatch[1];
    if (!VALID_DIATAXIS_TAGS.has(tag)) {
      errors.push(
        `docs/${page}: 'diataxis: ${tag}' is not a valid Diátaxis tag (allowed: ${[...VALID_DIATAXIS_TAGS].sort().join(", ")})`,
      );
      continue;
    }

    if (tag === "reference" && !exempt.has(page) && !pageLevelPending.has(page)) {
      // Either a markdown-it-include directive (`!!!include(_generated/...)!!!`)
      // or a VitePress `<<<` code transclusion satisfies the rule. Plain
      // back-tick fenced blocks do not count — the goal is references that
      // are mechanically derived from source.
      const hasInclude = /!!!include\(|<<<\s+@/.test(content);
      if (!hasInclude) {
        errors.push(
          `docs/${page}: tagged 'diataxis: reference' but contains no include directive (!!!include(...)!!! or <<< @/...). Add the include or list it under docs/.manifest.json#pendingExtraction with the blocking port.`,
        );
      }
    }
  }

  return errors;
}

/**
 * Cross-validate the section-level entries in `manifest.pendingExtraction`
 * against `<!-- pending-extraction: <token> -->` HTML breadcrumbs in their
 * pages. Every section entry must have a matching breadcrumb; every
 * breadcrumb must have a matching section entry. Page-level entries (no
 * `section`) are skipped — those are governed by the J-2 include-directive
 * gate, not breadcrumbs.
 */
export async function collectPendingExtractionBreadcrumbIssues(
  manifest: DocsManifest,
  read: (relativePath: string) => Promise<string>,
): Promise<string[]> {
  const errors: string[] = [];
  const sectionEntries = (manifest.pendingExtraction ?? []).filter(
    (entry): entry is PendingExtractionEntry & { section: string } => entry.section !== undefined,
  );

  const byPage = new Map<string, Set<string>>();
  for (const entry of sectionEntries) {
    const set = byPage.get(entry.page) ?? new Set<string>();
    set.add(entry.section);
    byPage.set(entry.page, set);
  }

  for (const [page, sections] of byPage) {
    let content: string;
    try {
      content = await read(`docs/${page}`);
    } catch {
      continue;
    }
    for (const section of sections) {
      const safeSection = section.replace(/[^A-Za-z0-9_-]/g, "");
      const breadcrumbRe = new RegExp(`<!--\\s*pending-extraction:\\s*${safeSection}\\s*-->`);
      if (!breadcrumbRe.test(content)) {
        errors.push(
          `docs/${page}: pendingExtraction lists section "${section}" but the page contains no matching <!-- pending-extraction: ${section} --> breadcrumb`,
        );
      }
    }
  }

  const breadcrumbScanRe = /<!--\s*pending-extraction:\s*([A-Za-z0-9_-]+)\s*-->/g;
  for (const page of manifest.handAuthoredPages) {
    // The `_generated/` tree is either machine-emitted partials (no
    // breadcrumbs by design) or `_generated/README.md` (documents the
    // breadcrumb syntax itself; example syntax in the doc body would
    // otherwise be misread as real breadcrumbs).
    if (page.startsWith("_generated/")) continue;
    let content: string;
    try {
      content = await read(`docs/${page}`);
    } catch {
      continue;
    }
    const knownSections = byPage.get(page) ?? new Set<string>();
    breadcrumbScanRe.lastIndex = 0;
    for (;;) {
      const match = breadcrumbScanRe.exec(content);
      if (match === null) break;
      const token = match[1];
      if (!knownSections.has(token)) {
        errors.push(
          `docs/${page}: contains <!-- pending-extraction: ${token} --> breadcrumb but the manifest has no matching pendingExtraction entry`,
        );
      }
    }
  }

  return errors;
}

async function collectScriptTsFiles(root: string, relativeDir: string): Promise<string[]> {
  const absoluteDir = path.join(root, relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const childRelative = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectScriptTsFiles(root, childRelative)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(childRelative);
    }
  }
  return files;
}

export async function collectTsMorphBoundaryIssues(root = repoRoot): Promise<string[]> {
  const errors: string[] = [];
  const tsFiles = await collectScriptTsFiles(root, "scripts");
  // Anchor on a line that begins with `import` so the boundary gate's own
  // regex literal (which contains the string `"ts-morph"`) is not flagged
  // as a violation. Dynamic `import("ts-morph")` calls fall outside this
  // pattern and are caught by code review; the boundary holds because the
  // wrapper module is the only place that needs ts-morph today.
  const tsMorphImportRe = /^\s*import\b[^;\n]*?["']ts-morph["']/m;
  for (const relativePath of tsFiles) {
    const absolute = path.join(root, relativePath);
    const content = await readFile(absolute, "utf8");
    if (!tsMorphImportRe.test(content)) continue;
    if (relativePath !== TS_MORPH_ALLOWED_PATH) {
      errors.push(
        `${relativePath}: imports 'ts-morph' but the wrapper boundary requires only ${TS_MORPH_ALLOWED_PATH} to import it. Consume introspection via that module's exported helpers.`,
      );
    }
  }
  return errors;
}

export async function collectFileExpectationIssues(
  expectations: readonly FileExpectation[],
  read: (relativePath: string) => Promise<string>,
): Promise<string[]> {
  const issueGroups = await Promise.all(
    expectations.map(async (expectation) => {
      const errors: string[] = [];
      let content: string;
      try {
        content = await read(expectation.path);
      } catch (error) {
        if (expectation.optional && isNotFoundError(error)) {
          return errors;
        }
        throw error;
      }

      if (expectation.contains) {
        ensureIncludes(content, expectation.path, expectation.contains, errors);
      }
      if (expectation.forbids) {
        ensureForbids(content, expectation.path, expectation.forbids, errors);
      }

      return errors;
    }),
  );

  return issueGroups.flat();
}

export async function collectDocsConsistencyErrors(root = repoRoot): Promise<string[]> {
  const manifests = await readPackageManifests(root);
  if (manifests.length === 0) {
    throw new Error("No publishable package manifests were found under packages/ or extras/.");
  }

  const versions = [...new Set(manifests.map((manifest) => manifest.version))];
  if (versions.length !== 1) {
    throw new Error(`Expected one publishable package version, found: ${versions.join(", ")}`);
  }

  const expectations: FileExpectation[] = [
    {
      path: "README.md",
      contains: [
        docsUrl,
        launcherRuntimeCommand,
        browserSmokeCommand,
        liveBrowserCommand,
        "## Quick Start",
        "## Advanced Usage",
        CANONICAL_POSITIONING_MARKER,
      ],
    },
    {
      path: "docs/surfaces.md",
      contains: [
        browserSmokeCommand,
        liveBrowserCommand,
        "## Browser",
        "## CLI",
        "## Runtime Matrix",
      ],
    },
    {
      path: "docs/protocols.md",
      contains: ["## Standards Map", "## ACP", "## A2A", "## AG-UI", "## A2UI"],
    },
    {
      path: "docs/primitives.md",
      contains: ["## Package Map", "## Layer Diagram"],
    },
    {
      path: "docs/develop/contribute.md",
      contains: [
        "## Tooling",
        "## Release Posture",
        "### Docs Publication Contract",
        "### Release Operator Contract",
      ],
    },
    {
      path: "docs/streaming-and-events.md",
      contains: ["message/stream", "tasks/resubscribe", "## Current support"],
    },
    {
      path: "docs/harness-guide.md",
      contains: ["## ACP Host Embedding"],
    },
    {
      path: "docs/index.md",
      contains: [
        "## Two tracks, one runtime",
        "## Hello, world",
        "## What you get",
        "[Surfaces](/surfaces)",
        CANONICAL_POSITIONING_MARKER,
      ],
    },
    {
      path: "docs/api/typedoc-sidebar.json",
      forbids: ["/docs/api/"],
    },
    {
      path: "docs/api/index.md",
      contains: ["# API Reference"],
      forbids: ["# @agents-js/root"],
    },
    {
      path: "docs/getting-started.md",
      contains: [
        "bun run dev",
        "## Quickstart commands",
        "## Prove the second wire (CLI)",
        "## Prove session continuity",
        "Open URL",
        "## Contributor quickstart",
      ],
    },
  ];

  const errors = await collectFileExpectationIssues(expectations, (relativePath) =>
    readText(relativePath, root),
  );

  const scanFiles = await readExistingScanFiles(root);
  errors.push(...collectProviderHostReferenceIssues(scanFiles));
  errors.push(...collectRemovedDocPathIssues(scanFiles));
  errors.push(...collectHandAuthoredStatusIssues(scanFiles));
  errors.push(...collectUserFacingForbiddenIssues(scanFiles));

  const manifestNames = await readWorkspaceManifestNames(root);
  const graphPackageNames = await readGraphPackageNames(root);
  errors.push(...collectGraphPackageIssues(manifestNames, graphPackageNames));

  const docsManifest = JSON.parse(await readText("docs/.manifest.json", root)) as DocsManifest;
  errors.push(
    ...(await collectFrontmatterTagIssues(docsManifest, (relativePath) =>
      readText(relativePath, root),
    )),
  );
  errors.push(
    ...(await collectPendingExtractionBreadcrumbIssues(docsManifest, (relativePath) =>
      readText(relativePath, root),
    )),
  );
  errors.push(...(await collectTsMorphBoundaryIssues(root)));

  // Rule A: curated harness names must appear in both the consolidated surfaces
  // page (docs/surfaces.md) and the landing page. Harnesss content has moved
  // from runtime-matrix.md to surfaces.md.
  const [surfacesMd, indexMd] = await Promise.all([
    readText("docs/surfaces.md", root),
    readText("docs/index.md", root),
  ]);
  for (const harness of CURATED_HARNESSES) {
    if (!surfacesMd.includes(harness)) {
      errors.push(
        `docs/surfaces.md is missing curated harness "${harness}" — it should appear in the Practical Use section. If the harness has been retired, remove it from CURATED_HARNESSES in scripts/docs-consistency.ts as well.`,
      );
    }
    if (!indexMd.includes(harness)) {
      errors.push(
        `docs/index.md is missing curated harness "${harness}" — it should appear in the topology section. If the harness has been retired, remove it from CURATED_HARNESSES in scripts/docs-consistency.ts as well.`,
      );
    }
  }
  // Removed docs/multi-agent.md existence check; harnesses are now represented on docs/surfaces.md
  // and should appear at least twice there.
  const curatedInSurfaces = CURATED_HARNESSES.filter((h) => surfacesMd.includes(h));
  if (curatedInSurfaces.length < 2) {
    errors.push(
      `docs/surfaces.md: expected at least two curated harnesses to be referenced; found ${curatedInSurfaces.length} of ${CURATED_HARNESSES.length}`,
    );
  }

  // Rule B: every @agents-js/* token referenced in the landing page must map
  // to a real workspace package. docs/acp-host.md is scanned on a best-effort
  // basis (worker 8 is concurrently editing it) — any dangling references
  // there are reported but use the same error channel.
  const validPackageNames = new Set(manifestNames);
  const sortedRealPackages = [...validPackageNames].sort().join(", ");
  const packageRefRegex = /@agents-js\/[a-z][a-z0-9-]*/g;
  const scanPackageRefs = (content: string, filePath: string): void => {
    const uniqueRefs = new Set(content.match(packageRefRegex) ?? []);
    for (const ref of uniqueRefs) {
      if (PACKAGE_REF_EXCLUSIONS.has(ref)) continue;
      if (!validPackageNames.has(ref)) {
        errors.push(
          `${filePath} references "${ref}" which is not a real workspace package. Real packages: [${sortedRealPackages}]`,
        );
      }
    }
  };
  scanPackageRefs(indexMd, "docs/index.md");
  try {
    scanPackageRefs(await readText("docs/harness-guide.md", root), "docs/harness-guide.md");
  } catch {
    // Optional in downstream doc-only fixtures.
  }

  return errors;
}

async function main(): Promise<void> {
  const manifests = await readPackageManifests();
  const versions = [...new Set(manifests.map((manifest) => manifest.version))];
  const currentVersion = versions.length === 1 ? versions[0] : "mixed versions";
  const publishOrder = computePublishOrder(await readPublishablePackages(repoRoot));
  const publishablePackageCount = publishOrder.length;
  const errors = await collectDocsConsistencyErrors();

  if (errors.length > 0) {
    console.error("[docs:consistency] documentation drift detected:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(
    `[docs:consistency] OK: ${publishablePackageCount} publishable packages at ${currentVersion}; docs host ${docsUrl}`,
  );
}

if (import.meta.main) {
  await main();
}
