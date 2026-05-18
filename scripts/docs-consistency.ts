#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { listGatewayRuntimeIds } from "@agents-js/gateway-runtime";
import { computePublishOrder, readPublishablePackages } from "./release-preflight.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Diátaxis frontmatter governance (J-2)
// ─────────────────────────────────────────────────────────────────────────────
// Every page in `docs/.manifest.json#handAuthoredPages` must carry a
// `diataxis:` frontmatter tag classifying its purpose, drawn from the
// closed set below. The presence of a `diataxis:` tag is real
// architectural metadata; the gate catches typoed tags and missing
// frontmatter.
const VALID_DIATAXIS_TAGS = new Set(["tutorial", "howto", "reference", "explanation", "landing"]);

interface DocsManifest {
  handAuthoredPages: string[];
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
  dependencies?: Record<string, string>;
}

export interface FileExpectation {
  contains?: string[];
  forbids?: (string | RegExp)[];
  optional?: boolean;
  path: string;
}

interface GraphPackage {
  name?: unknown;
  version?: unknown;
  internal_deps?: unknown;
}

interface DependencyGraph {
  packages?: GraphPackage[];
}

interface NormalizedGraphPackage {
  name: string;
  version: string;
  internalDeps: string[];
}

interface TextFile {
  content: string;
  path: string;
}

const repoRoot = path.resolve(import.meta.dir, "..");

// Publicly-published docs hostname. Override via env for forks / mirrors;
// default is the project's canonical site.
const docsHostname = process.env.AGENTS_JS_DOCS_HOSTNAME?.trim() || "agents-js.bodal.dev";
const docsUrl = `https://${docsHostname}/`;
const launcherRuntimeCommand = "bun run dev --runtime claude";
const browserSmokeCommand = "bun run browser:smoke";
const liveBrowserCommand = "bun run e2e:web:live -- --runtime claude";
// README is the canonical positioning source; docs/index.md is derived. Both
// are required to contain this marker via the `contains` expectation list
// below.
export const CANONICAL_POSITIONING_MARKER = "A TypeScript library tying together";

// Bun is the workspace's internal toolchain, not a consumer-facing product
// requirement. Likewise, the docs should not regress into "not published yet"
// phrasing around @agents-js/cli. These phrases are intentionally scanned only
// in user-facing docs, not contributor/release-runbook pages.
export const userFacingForbiddenPhrases: readonly { label: string; pattern: RegExp }[] = [
  { label: "consumer-facing 'Bun toolkit' framing", pattern: /\bBun toolkit\b/gi },
  { label: "consumer-facing 'typed Bun' framing", pattern: /\btyped Bun\b/gi },
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

const userFacingForbiddenScanPaths = [
  "README.md",
  "docs/index.md",
  "docs/getting-started.md",
  "docs/surfaces.md",
  "docs/primitives.md",
  "docs/protocols.md",
  "docs/harness-guide.md",
  "docs/streaming-and-events.md",
  "docs/observability.md",
  "docs/public/llms.txt",
  "docs/public/llms-full.txt",
] as const;

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

/**
 * Cross-check that each graph entry's `version` and `internal_deps` match the
 * underlying manifest. Membership is validated separately by
 * {@link collectGraphPackageIssues}; this function ASSUMES membership is
 * already checked and only validates the per-package details.
 *
 * Why this exists: the earlier shape of this gate only checked name
 * membership, which let `docs/public/graph.json` drift to a stale `version`
 * (e.g. 0.4.0 when manifests had advanced to 0.5.1) without failing the
 * consistency check. Same pattern would also let an internal_deps edge
 * silently rot if a manifest added or removed a first-party dep without
 * a graph regen.
 */
export function collectGraphVersionEdgeIssues(
  manifests: readonly Pick<PackageManifest, "name" | "version" | "dependencies">[],
  graphPackages: readonly NormalizedGraphPackage[],
): string[] {
  const errors: string[] = [];
  const graphByName = new Map<string, NormalizedGraphPackage>();
  for (const pkg of graphPackages) {
    graphByName.set(pkg.name, pkg);
  }
  for (const manifest of manifests) {
    const graph = graphByName.get(manifest.name);
    if (graph === undefined) {
      // Membership issue — handled by collectGraphPackageIssues; skip here.
      continue;
    }
    if (graph.version !== manifest.version) {
      errors.push(
        `docs/public/graph.json: ${manifest.name} version drift — manifest=${manifest.version}, graph=${graph.version}. Run \`bun scripts/dep-graph-gen.ts\` to regenerate.`,
      );
    }
    const manifestInternalDeps = extractInternalDeps(manifest.dependencies).sort();
    const graphInternalDeps = [...graph.internalDeps].sort();
    if (
      manifestInternalDeps.length !== graphInternalDeps.length ||
      manifestInternalDeps.some((dep, index) => dep !== graphInternalDeps[index])
    ) {
      const missing = manifestInternalDeps.filter((dep) => !graphInternalDeps.includes(dep));
      const extra = graphInternalDeps.filter((dep) => !manifestInternalDeps.includes(dep));
      const parts: string[] = [];
      if (missing.length > 0) parts.push(`missing in graph: ${missing.join(", ")}`);
      if (extra.length > 0) parts.push(`stale in graph: ${extra.join(", ")}`);
      errors.push(
        `docs/public/graph.json: ${manifest.name} internal_deps drift — ${parts.join("; ")}. Run \`bun scripts/dep-graph-gen.ts\` to regenerate.`,
      );
    }
  }
  return errors;
}

function extractInternalDeps(deps: Record<string, string> | undefined): string[] {
  if (deps === undefined) return [];
  return Object.keys(deps).filter((name) => name.startsWith("@agents-js/"));
}

function normalizeGraphPackage(pkg: GraphPackage): NormalizedGraphPackage | undefined {
  if (typeof pkg.name !== "string" || pkg.name.length === 0) return undefined;
  if (typeof pkg.version !== "string" || pkg.version.length === 0) return undefined;
  if (!Array.isArray(pkg.internal_deps)) return undefined;
  const internalDeps = pkg.internal_deps.filter(
    (dep): dep is string => typeof dep === "string" && dep.length > 0,
  );
  return { name: pkg.name, version: pkg.version, internalDeps };
}

async function readGraphPackages(root = repoRoot): Promise<NormalizedGraphPackage[]> {
  const graph = JSON.parse(await readText("docs/public/graph.json", root)) as DependencyGraph;
  if (!Array.isArray(graph.packages)) return [];
  return graph.packages
    .map(normalizeGraphPackage)
    .filter((pkg): pkg is NormalizedGraphPackage => pkg !== undefined);
}

function resetPattern(pattern: RegExp): RegExp {
  pattern.lastIndex = 0;
  return pattern;
}

function collectPatternMatches(content: string, pattern: RegExp): string[] {
  const matches = content.match(resetPattern(pattern));
  return matches ? [...new Set(matches)] : [];
}

export function collectUserFacingForbiddenIssues(files: readonly TextFile[]): string[] {
  const errors: string[] = [];
  for (const file of files) {
    for (const { label, pattern } of userFacingForbiddenPhrases) {
      for (const match of collectPatternMatches(file.content, pattern)) {
        errors.push(`${file.path}: contains ${label}: ${match}`);
      }
    }
  }
  return errors;
}

async function readUserFacingForbiddenScanFiles(root = repoRoot): Promise<TextFile[]> {
  const files: TextFile[] = [];
  for (const relativePath of userFacingForbiddenScanPaths) {
    files.push({ path: relativePath, content: await readText(relativePath, root) });
  }
  return files;
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

  for (const page of manifest.handAuthoredPages) {
    let content: string;
    try {
      content = await read(`docs/${page}`);
    } catch (err) {
      // Surface the underlying failure rather than swallowing every read
      // error as "missing"; only ENOENT collapses into a clean diagnostic.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        errors.push(`docs/${page}: listed in manifest.handAuthoredPages but file does not exist`);
      } else {
        errors.push(
          `docs/${page}: listed in manifest.handAuthoredPages but unreadable: ${(err as Error).message}`,
        );
      }
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
      contains: ["## Browser", "## CLI", "## Runtime Matrix"],
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
      ],
    },
  ];

  const errors = await collectFileExpectationIssues(expectations, (relativePath) =>
    readText(relativePath, root),
  );
  errors.push(...collectUserFacingForbiddenIssues(await readUserFacingForbiddenScanFiles(root)));

  const manifestNames = await readWorkspaceManifestNames(root);
  const graphPackageNames = await readGraphPackageNames(root);
  errors.push(...collectGraphPackageIssues(manifestNames, graphPackageNames));

  const publishableManifests = await readPackageManifests(root);
  const graphPackages = await readGraphPackages(root);
  errors.push(...collectGraphVersionEdgeIssues(publishableManifests, graphPackages));

  const docsManifest = JSON.parse(await readText("docs/.manifest.json", root)) as DocsManifest;
  errors.push(
    ...(await collectFrontmatterTagIssues(docsManifest, (relativePath) =>
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
