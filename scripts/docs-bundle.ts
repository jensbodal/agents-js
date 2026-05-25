/**
 * docs-bundle.ts — Generates docs/public/llms.txt, docs/public/llms-full.txt,
 * and one per-package index file under docs/public/per-package/.
 *
 * Output lives under `docs/public/` so VitePress copies the bundles to the
 * dist root (`/llms.txt`, `/llms-full.txt`, `/per-package/<name>.txt`); files
 * at `docs/<name>.txt` are not copied by VitePress and would 404 on the
 * published site.
 *
 * Three output families:
 *  - llms.txt — top-level project-wide entry-point per the llmstxt.org spec
 *    (H1 + blockquote summary + H2-grouped link sections, each annotated)
 *  - llms-full.txt — single bundle: project-wide entry + every doc page +
 *    every per-package index appended at the bottom under "Per-package
 *    indexes". The whole bundle is what a consumer pulls when they want
 *    everything in one shot.
 *  - docs/public/per-package/agents-js-<short>-llms.txt — one focused
 *    package index per publishable package (`@agents-js/<short>`). Each
 *    file is H1 with the package name + a one-line summary + the package
 *    README content. Acts as a context-window-budget slice so an agent
 *    can pull just the package it cares about instead of the full
 *    monolith.
 *
 * Coupling discipline: a single 'bun run docs:bundle' regenerates all
 * outputs. 'bun run docs:bundle --check' validates every output against
 * committed content and fails on any drift, so partial regenerations
 * cannot ship. The per-package list is derived from packages/*\/package.json
 * (descriptions read from the manifest), so the only manual step required
 * when adding a new publishable package is keeping the package README
 * generated via 'bun run docs:readmes'.
 *
 * Link descriptions and section groupings for the top-level docs are
 * authored inline in {@link PAGES}. Per the llmstxt.org spec, manual
 * authorship beats auto-extraction for that surface. Per-package summaries
 * come from the package's `description` field in package.json so the
 * single source of truth lives with the package metadata.
 *
 * See https://llmstxt.org/ for the spec.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const DOCS_DIR = join(REPO_ROOT, "docs");
const PUBLIC_DIR = join(DOCS_DIR, "public");
const PER_PACKAGE_DIR = join(PUBLIC_DIR, "per-package");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

// CLI: `bun scripts/docs-bundle.ts` writes; `--check` compares the would-be
// content against the committed files and exits non-zero on drift. The check
// mode is wired into `bun run check` so stale `docs/public/llms.txt` /
// `docs/public/llms-full.txt` cannot ship to the published site.
const args = process.argv.slice(2);
const isCheck = args.includes("--check");
const unknownArgs = args.filter((arg) => arg !== "--check");
if (unknownArgs.length > 0) {
  console.error(`[docs-bundle] Unknown argument(s): ${unknownArgs.join(", ")}`);
  console.error("Usage: bun scripts/docs-bundle.ts [--check]");
  process.exit(2);
}

function writeOrCheck(path: string, content: string, label: string): void {
  if (isCheck) {
    let existing: string;
    try {
      existing = readFileSync(path, "utf-8");
    } catch {
      console.error(
        `[docs-bundle:check] ${label} is missing at ${path}. Run \`bun run docs:bundle\` and commit the result.`,
      );
      process.exit(1);
    }
    if (existing !== content) {
      console.error(
        `[docs-bundle:check] ${label} at ${path} is out of date. Run \`bun run docs:bundle\` and commit the result.`,
      );
      process.exit(1);
    }
    return;
  }
  writeFileSync(path, content);
}
const PROJECT_NAME = "agents-js";
const SUMMARY =
  "ACP runtimes over A2A — operator CLI and reusable client library for building agent surfaces.";
const BASE_URL = "https://agents-js.bodal.dev";

/**
 * A documentation page entry. `category` controls which H2 section the
 * link appears under in llms.txt; `description` is the authored blurb
 * shown after the link. Pages flagged `optional: true` collect into a
 * trailing "Optional" section per the llmstxt.org convention for
 * lower-priority context.
 */
interface PageEntry {
  name: string;
  category: string;
  description: string;
  optional?: boolean;
}

const PAGES: PageEntry[] = [
  {
    name: "index.md",
    category: "Overview",
    description: "What agents-js is, how the pieces fit together, and the feature inventory.",
  },
  {
    name: "getting-started.md",
    category: "Getting Started",
    description: "Run a local ACP runtime behind an A2A gateway in one command, browser or CLI.",
  },
  {
    name: "surfaces.md",
    category: "Getting Started",
    description: "The shipped consumer surfaces — browser app, CLI, and multi-agent dispatch.",
  },
  {
    name: "primitives.md",
    category: "Core Concepts",
    description:
      "Composable packages: protocol primitives, tool surface (fetchContext, findTools, spawnAgent), and the Ports & Adapters layering.",
  },
  {
    name: "protocols.md",
    category: "Core Concepts",
    description:
      "Canonical map of JSON-RPC, ACP, A2A, MCP, AG-UI, A2UI, and runtime manifests — what is implemented, validated, or passed through.",
  },
  {
    name: "harness-guide.md",
    category: "Core Concepts",
    description:
      "Building a harness on agents-js: Gen-1 through Gen-3 agent integrations, permissions, terminals, and the host adapter seams.",
  },
  {
    name: "streaming-and-events.md",
    category: "Core Concepts",
    description: "Event vocabularies and streaming behavior across ACP, A2A, and AG-UI.",
  },
  {
    name: "observability.md",
    category: "Operations",
    description:
      "Logger, logStore, EvalTransport, and the tool-call-trace v0.1 structured event schema for observability and audit.",
  },
  {
    name: "develop/contribute.md",
    category: "Optional",
    description: "Contributor + release-playbook reference. Not needed for first-time readers.",
    optional: true,
  },
  {
    name: "develop/browser-entry-points.md",
    category: "Optional",
    description:
      "Browser-safe package entry conventions for packages with server-only main entries.",
    optional: true,
  },
];

function readPage(filename: string): string {
  const absolute = join(DOCS_DIR, filename);
  return resolveIncludes(readFileSync(absolute, "utf-8"), dirname(absolute));
}

/**
 * Expand `markdown-it-include` directives (`!!!include(<path>)!!!`)
 * inside `content`, recursively, so the LLM bundle ships fully-resolved
 * Markdown rather than literal include tokens.
 *
 * Path resolution mirrors VitePress's at-build-time behavior: the path
 * inside the directive is resolved relative to the consuming file's
 * directory. A partial may itself contain further include directives,
 * so resolution recurses.
 *
 * Unresolved partials (e.g. one consuming page lists a file that doesn't
 * exist on disk) throw rather than emitting the literal directive — the
 * bundle's whole point is that the LLM consumer never sees an
 * `!!!include(` substring.
 */
function resolveIncludes(content: string, baseDir: string): string {
  const includePattern = /!!!include\(([^)]+)\)!!!/g;
  return content.replace(includePattern, (_match, rawPath: string) => {
    const includedPath = resolve(baseDir, rawPath.trim());
    let included: string;
    try {
      included = readFileSync(includedPath, "utf-8");
    } catch (err) {
      throw new Error(
        `[docs-bundle] cannot resolve include "${rawPath}" (resolved to ${includedPath}): ${(err as Error).message}`,
      );
    }
    return resolveIncludes(included, dirname(includedPath));
  });
}

/**
 * Fallback description extractor. Manual descriptions in {@link PAGES}
 * should cover every real page; this exists so a page temporarily missing
 * from the manual table still produces a non-empty description rather
 * than a literal `---` (the prior bug).
 *
 * Correctly skips YAML frontmatter, blockquote callouts, and headings.
 */
function extractDescription(content: string): string {
  const lines = content.split("\n");
  let cursor = 0;

  // Skip YAML frontmatter if present.
  if (lines[0]?.trim() === "---") {
    cursor = 1;
    while (cursor < lines.length && lines[cursor]?.trim() !== "---") {
      cursor += 1;
    }
    cursor += 1; // step past closing `---`
  }

  for (; cursor < lines.length; cursor += 1) {
    const trimmed = lines[cursor]?.trim() ?? "";
    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) continue;
    if (trimmed.startsWith(">")) continue;
    if (trimmed.startsWith("---")) continue;
    // Skip code fences + VitePress hero-layout blocks (they start with
    // `layout:` or indentation under a frontmatter key).
    if (trimmed.startsWith("```")) continue;

    const cleaned = trimmed
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1");
    if (cleaned.length === 0) continue;

    return cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned;
  }
  return "";
}

function resolveDescription(page: PageEntry, content: string): string {
  if (page.description.length > 0) {
    return page.description;
  }
  const extracted = extractDescription(content);
  if (extracted.length > 0) {
    return extracted;
  }
  throw new Error(
    `[docs-bundle] No description for ${page.name}. Add one to PAGES in scripts/docs-bundle.ts.`,
  );
}

function pageUrl(name: string): string {
  const slug = name.replace(/\.md$/, ".html");
  return `${BASE_URL}/${slug}`;
}

// ---------------------------------------------------------------------------
// Per-package index discovery
// ---------------------------------------------------------------------------

/**
 * One entry per publishable package. `shortName` is the bare suffix after the
 * `@agents-js/` scope and drives the on-disk filename
 * (`agents-js-<shortName>-llms.txt`) and the published URL slug.
 */
interface PackageIndex {
  shortName: string;
  packageName: string;
  description: string;
  readme: string;
}

function readPackageJson(
  packageDir: string,
): { name?: string; description?: string; private?: boolean } | null {
  const manifestPath = join(packageDir, "package.json");
  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return null;
  }
}

function readPackageReadme(packageDir: string): string | null {
  const readmePath = join(packageDir, "README.md");
  try {
    return readFileSync(readmePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Enumerate every publishable package under `packages/` that ships with a
 * README. A package is publishable when its package.json does NOT carry
 * `"private": true`. Packages without a README are skipped with a warning;
 * the fix is to run `bun run docs:readmes` (or hand-author the README for
 * skipped packages) so every published package has an authored entry-point.
 */
function discoverPackageIndexes(): PackageIndex[] {
  const entries = readdirSync(PACKAGES_DIR);
  const indexes: PackageIndex[] = [];
  for (const entry of entries) {
    const packageDir = join(PACKAGES_DIR, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(packageDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const manifest = readPackageJson(packageDir);
    if (!manifest) continue;
    if (manifest.private === true) continue;
    const packageName = manifest.name;
    if (!packageName?.startsWith("@agents-js/")) continue;
    const shortName = packageName.slice("@agents-js/".length);
    const description = manifest.description?.trim() ?? "";
    if (description.length === 0) {
      throw new Error(
        `[docs-bundle] ${packageName} is missing a "description" in package.json. ` +
          `Add one — it is the per-package summary surfaced in llms.txt.`,
      );
    }
    const readme = readPackageReadme(packageDir);
    if (readme === null) {
      throw new Error(
        `[docs-bundle] ${packageName} has no README.md. Run \`bun run docs:readmes\` ` +
          `to generate one, or hand-author it for packages skipped by the README generator.`,
      );
    }
    indexes.push({ shortName, packageName, description, readme: readme.trim() });
  }
  indexes.sort((a, b) => a.shortName.localeCompare(b.shortName));
  return indexes;
}

function perPackageFilename(shortName: string): string {
  return `agents-js-${shortName}-llms.txt`;
}

function perPackageUrl(shortName: string): string {
  return `${BASE_URL}/per-package/${perPackageFilename(shortName)}`;
}

function buildPerPackageBundle(index: PackageIndex): string {
  const header = [
    `# ${index.packageName}`,
    "",
    `> ${index.description}`,
    "",
    `Canonical: ${perPackageUrl(index.shortName)}`,
    "",
    "---",
    "",
  ];
  return `${header.join("\n")}${index.readme.trim()}\n`;
}

// ---------------------------------------------------------------------------
// Read all pages
// ---------------------------------------------------------------------------

interface ResolvedPage extends PageEntry {
  content: string;
  descriptionText: string;
}

const resolvedPages: ResolvedPage[] = PAGES.map((page) => {
  const content = readPage(page.name);
  return { ...page, content, descriptionText: resolveDescription(page, content) };
});

// ---------------------------------------------------------------------------
// Build llms.txt
// ---------------------------------------------------------------------------

const required = resolvedPages.filter((page) => !page.optional);
const optional = resolvedPages.filter((page) => page.optional);

// Preserve authored order of categories as they first appear in PAGES.
const categoryOrder: string[] = [];
for (const page of required) {
  if (!categoryOrder.includes(page.category)) {
    categoryOrder.push(page.category);
  }
}

const lines: string[] = [`# ${PROJECT_NAME}`, "", `> ${SUMMARY}`, ""];

for (const category of categoryOrder) {
  lines.push(`## ${category}`);
  lines.push("");
  for (const page of required.filter((p) => p.category === category)) {
    lines.push(`- [${page.name}](${pageUrl(page.name)}): ${page.descriptionText}`);
  }
  lines.push("");
}

// Per-package indexes are discovered from packages/*/package.json so the list
// stays in lockstep with the publishable surface. Each entry surfaces in
// llms.txt under "Per-package indexes" and gets its own focused file under
// docs/public/per-package/ for context-window-budget pulls.
const packageIndexes = discoverPackageIndexes();

if (packageIndexes.length > 0) {
  lines.push("## Per-package indexes");
  lines.push("");
  for (const index of packageIndexes) {
    lines.push(`- [${index.packageName}](${perPackageUrl(index.shortName)}): ${index.description}`);
  }
  lines.push("");
}

if (optional.length > 0) {
  lines.push("## Optional");
  lines.push("");
  for (const page of optional) {
    lines.push(`- [${page.name}](${pageUrl(page.name)}): ${page.descriptionText}`);
  }
  lines.push("");
}

const llmsTxt = `${lines.join("\n").trimEnd()}\n`;
writeOrCheck(join(PUBLIC_DIR, "llms.txt"), llmsTxt, "llms.txt");

// ---------------------------------------------------------------------------
// Write per-package bundles
// ---------------------------------------------------------------------------

// Ensure the per-package directory exists before writing (no-op when checking
// or when the directory already exists). Skipping mkdir during check mode
// keeps the script side-effect-free for read-only validation.
if (!isCheck) {
  try {
    mkdirSync(PER_PACKAGE_DIR, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

for (const index of packageIndexes) {
  const bundle = buildPerPackageBundle(index);
  writeOrCheck(
    join(PER_PACKAGE_DIR, perPackageFilename(index.shortName)),
    bundle,
    `per-package/${perPackageFilename(index.shortName)}`,
  );
}

// ---------------------------------------------------------------------------
// Build llms-full.txt
// ---------------------------------------------------------------------------

const fullParts: string[] = [llmsTxt.trimEnd(), ""];

for (const page of resolvedPages) {
  fullParts.push("---");
  fullParts.push("");
  fullParts.push(page.content.trimEnd());
  fullParts.push("");
}

// Per-package bundles appended after top-level docs. Same `---` separator
// keeps the format machine-parsable as a sequence of Markdown sections.
// Consumers who want a focused slice should pull the per-package file
// directly rather than parsing it out of the rollup.
if (packageIndexes.length > 0) {
  fullParts.push("---");
  fullParts.push("");
  fullParts.push("# Per-package indexes");
  fullParts.push("");
  fullParts.push(
    "The sections below mirror the per-package files under " +
      "/per-package/agents-js-<name>-llms.txt. Each is a focused index for one " +
      "publishable package; pull the per-package file directly for a smaller " +
      "context-window slice.",
  );
  fullParts.push("");
  for (const index of packageIndexes) {
    fullParts.push("---");
    fullParts.push("");
    fullParts.push(buildPerPackageBundle(index).trimEnd());
    fullParts.push("");
  }
}

const llmsFullTxt = `${fullParts.join("\n")}\n`;
writeOrCheck(join(PUBLIC_DIR, "llms-full.txt"), llmsFullTxt, "llms-full.txt");

if (isCheck) {
  console.log(
    `✓ docs-bundle:check: llms.txt (${llmsTxt.length} bytes), llms-full.txt ` +
      `(${llmsFullTxt.length} bytes), and ${packageIndexes.length} per-package ` +
      `bundles under per-package/ match committed content.`,
  );
} else {
  console.log(
    `✓ docs-bundle: wrote llms.txt (${llmsTxt.length} bytes, ${required.length} required + ` +
      `${optional.length} optional links + ${packageIndexes.length} per-package links across ` +
      `${categoryOrder.length} categories) and llms-full.txt (${llmsFullTxt.length} bytes) and ` +
      `${packageIndexes.length} per-package bundles.`,
  );
}
