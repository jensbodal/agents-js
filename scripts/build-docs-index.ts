import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

interface DocsEntry {
  path: string;
  title: string;
  anchor: string;
  heading: string;
  text: string;
}

const DOCS_ROOT = join(import.meta.dir, "..", "docs");
const PUBLIC_DIR = join(import.meta.dir, "..", "docs", "public");
const PUBLIC_OUT = join(PUBLIC_DIR, "docs-index.json");

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "public" || e.name === "api") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.name.endsWith(".md")) yield full;
  }
}

function extractTitle(md: string, fallback: string): string {
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch?.[1]) {
    const t = fmMatch[1].match(/^title:\s*(.+)$/m);
    if (t?.[1]) return t[1].trim();
  }
  const h1 = md.match(/^#\s+(.+)$/m);
  return h1?.[1] ? h1[1].trim() : fallback;
}

function* sectionsOf(md: string): Generator<{ heading: string; text: string }> {
  const lines = md.split("\n");
  let currentHeading = "Introduction";
  let buf: string[] = [];
  for (const line of lines) {
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h?.[2]) {
      if (buf.length) yield { heading: currentHeading, text: buf.join("\n").trim() };
      currentHeading = h[2].trim();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  if (buf.length) yield { heading: currentHeading, text: buf.join("\n").trim() };
}

async function main(): Promise<void> {
  const entries: DocsEntry[] = [];
  for await (const file of walk(DOCS_ROOT)) {
    const rel = relative(DOCS_ROOT, file);
    const md = await readFile(file, "utf8");
    const title = extractTitle(md, rel);
    const seenAnchors = new Map<string, number>();
    for (const section of sectionsOf(md)) {
      if (!section.text) continue;
      const baseAnchor = slugify(section.heading);
      const count = seenAnchors.get(baseAnchor) ?? 0;
      seenAnchors.set(baseAnchor, count + 1);
      const anchor = count === 0 ? baseAnchor : `${baseAnchor}-${count + 1}`;
      entries.push({
        path: rel,
        title,
        heading: section.heading,
        anchor,
        text: section.text.slice(0, 1200),
      });
    }
  }
  const corpus = { generatedAt: new Date().toISOString(), entries };
  await mkdir(PUBLIC_DIR, { recursive: true });
  await writeFile(PUBLIC_OUT, JSON.stringify(corpus));
  console.log(`docs-index: ${entries.length} entries → ${PUBLIC_OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
