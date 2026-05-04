/**
 * docs-bundle.ts — Generates docs/llms.txt and docs/llms-full.txt
 *
 * Follows the llmstxt.org spec:
 *  - llms.txt:  H1 project title + blockquoted summary + H2-grouped link
 *               sections, each link annotated with a brief description so
 *               an agent can prioritize what to load
 *  - llms-full.txt: Same header + full concatenated content of every page
 *
 * Link descriptions and section groupings are authored inline in
 * {@link PAGES}. Per the spec, manual authorship beats auto-extraction for
 * this surface — the llms.txt file is a curated reading list, not a scrape
 * of the first paragraph. Auto-extraction survives as a last-ditch
 * fallback (see {@link extractDescription}) but every real page SHOULD
 * carry a hand-written description so the output stays predictable.
 *
 * See https://llmstxt.org/ for the spec.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DOCS_DIR = join(import.meta.dir, "..", "docs");
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
  return readFileSync(join(DOCS_DIR, filename), "utf-8");
}

/**
 * Fallback description extractor. Manual descriptions in {@link PAGES}
 * should cover every real page; this exists so a page briefly missing
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

if (optional.length > 0) {
  lines.push("## Optional");
  lines.push("");
  for (const page of optional) {
    lines.push(`- [${page.name}](${pageUrl(page.name)}): ${page.descriptionText}`);
  }
  lines.push("");
}

const llmsTxt = `${lines.join("\n").trimEnd()}\n`;
writeFileSync(join(DOCS_DIR, "llms.txt"), llmsTxt);

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

const llmsFullTxt = `${fullParts.join("\n")}\n`;
writeFileSync(join(DOCS_DIR, "llms-full.txt"), llmsFullTxt);

console.log(
  `✓ docs-bundle: wrote llms.txt (${llmsTxt.length} bytes, ${required.length} required + ${optional.length} optional links across ${categoryOrder.length} categories) and llms-full.txt (${llmsFullTxt.length} bytes).`,
);
