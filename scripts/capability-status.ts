/**
 * Generate `docs/public/capability-status.json` from the hand-authored
 * classification in `scripts/capability-status.json`, JOINED against
 * `docs/public/graph.json`.
 *
 * Usage:
 *   bun scripts/capability-status.ts --write   # regenerate the artifact
 *   bun scripts/capability-status.ts --check   # fail on drift (no writes)
 *
 * The generator NEVER infers a capability tier — tier authority belongs to the
 * capability-reconciliation effort and lives in `scripts/capability-status.json`.
 * Its only honesty checks are STRUCTURAL: every `tier` must be in the enum, and
 * every package referenced by a capability must exist in `graph.json` (a stale
 * or typo'd package ref fails the gate loudly). It enriches each referenced
 * package with `{name, dir, version}` from the graph and computes tier counts.
 *
 * The drift gate (`docs:capability-status:check`, run from `bun run check`)
 * compares everything EXCEPT the volatile `generated_at` / `source_commit`
 * fields, so committing the artifact does not churn on timestamps.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCE = join(ROOT, "scripts/capability-status.json");
const GRAPH = join(ROOT, "docs/public/graph.json");
const OUT = join(ROOT, "docs/public/capability-status.json");
const GRAPH_MD_OUT = join(ROOT, "docs/_generated/capability-graph.md");

const TIERS = ["demonstrated", "undemonstrated", "over-claimed", "missing"] as const;
type Tier = (typeof TIERS)[number];

/**
 * Worst-wins precedence for a package that serves several capabilities (lower
 * index wins): an over-claimed or missing facet dominates a demonstrated one,
 * so the graph never paints a partially-honest package green. Packages in no
 * capability render as "untiered".
 */
const TIER_PRECEDENCE: Tier[] = ["over-claimed", "missing", "undemonstrated", "demonstrated"];
const TIER_CLASS: Record<Tier | "untiered", string> = {
  "over-claimed": "overclaimed",
  missing: "missing",
  undemonstrated: "undemonstrated",
  demonstrated: "demonstrated",
  untiered: "untiered",
};

interface EvidenceEntry {
  kind: string;
  ref: string;
  note: string;
}
interface SourceCapability {
  title: string;
  tier: string;
  packages: string[];
  evidence: EvidenceEntry[];
  notes?: string;
}
interface SourceFile {
  capabilities: Record<string, SourceCapability>;
}
interface GraphPackage {
  name: string;
  dir: string;
  version: string;
}
interface GraphPackageFull extends GraphPackage {
  internal_deps?: string[];
}

function gitShortSha(): string {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : "unknown";
}

/**
 * Format `d` as Pacific ISO-8601 with an explicit numeric offset
 * (`YYYY-MM-DDTHH:mm:ss-07:00`), matching the team timestamp standard for
 * durable artifacts. Surfaced as quiet build metadata on the /ecosystem page.
 */
function pacificIso(d: Date): string {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "longOffset",
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  // longOffset renders e.g. "GMT-07:00"; strip the "GMT" prefix for ISO form.
  const offset = (p.timeZoneName ?? "GMT+00:00").replace(/^GMT/, "") || "+00:00";
  const hour = p.hour === "24" ? "00" : p.hour; // Intl can emit 24 for midnight
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}${offset}`;
}

function loadGraph(): Map<string, GraphPackage> {
  const raw = JSON.parse(readFileSync(GRAPH, "utf-8")) as unknown;
  const arr = (
    Array.isArray(raw) ? raw : ((raw as { packages?: unknown }).packages ?? [])
  ) as GraphPackage[];
  return new Map(arr.map((p) => [p.name, { name: p.name, dir: p.dir, version: p.version }]));
}

function loadGraphFull(): GraphPackageFull[] {
  const raw = JSON.parse(readFileSync(GRAPH, "utf-8")) as unknown;
  return (
    Array.isArray(raw) ? raw : ((raw as { packages?: unknown }).packages ?? [])
  ) as GraphPackageFull[];
}

/** Mermaid node id from a package name: `@agents-js/a2a-client` -> `a2a_client`. */
function nodeId(name: string): string {
  return name.replace(/^@agents-js\//, "").replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * Build the `docs/_generated/capability-graph.md` mermaid partial: a `graph LR`
 * of the internal dependency edges, each package node classed by its worst-wins
 * capability tier (or `untiered`). Deterministic — no timestamp — so the drift
 * check is a plain string compare.
 */
function buildGraphMd(): string {
  const source = JSON.parse(readFileSync(SOURCE, "utf-8")) as SourceFile;
  const packages = loadGraphFull();

  // package name -> set of tiers it appears under
  const tiersByPkg = new Map<string, Set<string>>();
  for (const cap of Object.values(source.capabilities)) {
    for (const pkg of cap.packages) {
      if (!tiersByPkg.has(pkg)) tiersByPkg.set(pkg, new Set());
      tiersByPkg.get(pkg)?.add(cap.tier);
    }
  }
  const tierClassFor = (name: string): string => {
    const tiers = tiersByPkg.get(name);
    if (!tiers || tiers.size === 0) return TIER_CLASS.untiered;
    const worst = TIER_PRECEDENCE.find((t) => tiers.has(t));
    return worst ? TIER_CLASS[worst] : TIER_CLASS.untiered;
  };

  // Only render packages that participate in at least one internal edge, so the
  // graph stays a connected dependency picture rather than a field of isolated
  // nodes.
  const names = new Set(packages.map((p) => p.name));
  const edges: Array<[string, string]> = [];
  const touched = new Set<string>();
  for (const p of packages) {
    for (const dep of p.internal_deps ?? []) {
      if (names.has(dep)) {
        edges.push([p.name, dep]);
        touched.add(p.name);
        touched.add(dep);
      }
    }
  }

  const renderable = packages
    .filter((p) => touched.has(p.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const lines: string[] = [];
  lines.push("<!-- AUTO-GENERATED by scripts/capability-status.ts — do not edit -->");
  lines.push("<!-- Source of truth: scripts/capability-status.json + docs/public/graph.json -->");
  lines.push("");
  lines.push("```mermaid");
  lines.push("graph LR");
  lines.push("  classDef demonstrated fill:#1a7f37,stroke:#1a7f37,color:#fff;");
  lines.push("  classDef undemonstrated fill:#0969da,stroke:#0969da,color:#fff;");
  lines.push("  classDef overclaimed fill:#c2820e,stroke:#c2820e,color:#fff;");
  lines.push("  classDef missing fill:#cf222e,stroke:#cf222e,color:#fff;");
  lines.push("  classDef untiered fill:#8c959f,stroke:#8c959f,color:#fff;");
  for (const p of renderable) {
    const id = nodeId(p.name);
    lines.push(`  ${id}["${p.name}"]:::${tierClassFor(p.name)}`);
  }
  for (const [src, dep] of edges.sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`))) {
    lines.push(`  ${nodeId(src)} --> ${nodeId(dep)}`);
  }
  lines.push("```");
  lines.push("");
  return `${lines.join("\n")}`;
}

/** Build the generated artifact, validating structure + the graph join. Throws on any violation. */
function build(): Record<string, unknown> {
  const source = JSON.parse(readFileSync(SOURCE, "utf-8")) as SourceFile;
  const graph = loadGraph();
  const errors: string[] = [];

  const capabilities = Object.entries(source.capabilities).map(([id, cap]) => {
    if (!TIERS.includes(cap.tier as Tier)) {
      errors.push(
        `capability "${id}": invalid tier "${cap.tier}" (expected one of ${TIERS.join(", ")})`,
      );
    }
    const packages = cap.packages.map((name) => {
      const pkg = graph.get(name);
      if (!pkg) {
        errors.push(`capability "${id}": package "${name}" not found in graph.json`);
        return { name, dir: "", version: "" };
      }
      return pkg;
    });
    return {
      id,
      title: cap.title,
      tier: cap.tier,
      packages,
      evidence: cap.evidence,
      notes: cap.notes ?? "",
    };
  });

  if (errors.length > 0) {
    throw new Error(
      `capability-status: ${errors.length} validation error(s):\n  - ${errors.join("\n  - ")}`,
    );
  }

  const tierCounts = Object.fromEntries(
    TIERS.map((t) => [t, capabilities.filter((c) => c.tier === t).length]),
  );

  return {
    _comment:
      "GENERATED by scripts/capability-status.ts from scripts/capability-status.json + docs/public/graph.json. Do not edit by hand.",
    generated_at: pacificIso(new Date()),
    source_commit: gitShortSha(),
    tier_counts: tierCounts,
    capabilities,
  };
}

/** Strip volatile fields so committing the artifact does not churn on timestamps/SHA. */
function stable(obj: Record<string, unknown>): string {
  const { generated_at: _g, source_commit: _s, ...rest } = obj;
  return JSON.stringify(rest, null, 2);
}

function main(): void {
  const checkMode = process.argv.includes("--check");
  const writeMode = process.argv.includes("--write");
  if (checkMode === writeMode) {
    console.error("Usage: bun scripts/capability-status.ts (--check | --write)");
    process.exit(2);
  }

  const generated = build();
  const graphMd = buildGraphMd();

  if (writeMode) {
    writeFileSync(OUT, `${JSON.stringify(generated, null, 2)}\n`, "utf-8");
    writeFileSync(GRAPH_MD_OUT, graphMd, "utf-8");
    const counts = generated.tier_counts as Record<string, number>;
    console.log(
      `✓ capability-status: wrote docs/public/capability-status.json (${(generated.capabilities as unknown[]).length} capabilities: ${Object.entries(
        counts,
      )
        .map(([t, n]) => `${n} ${t}`)
        .join(", ")}) + docs/_generated/capability-graph.md`,
    );
    return;
  }

  let current: Record<string, unknown>;
  try {
    current = JSON.parse(readFileSync(OUT, "utf-8")) as Record<string, unknown>;
  } catch {
    console.error(
      "✗ capability-status: docs/public/capability-status.json missing or unparseable; run bun run docs:capability-status",
    );
    process.exit(1);
  }

  if (stable(current) !== stable(generated)) {
    console.error("✗ capability-status: drift detected; run bun run docs:capability-status");
    process.exit(1);
  }

  let currentGraphMd = "";
  try {
    currentGraphMd = readFileSync(GRAPH_MD_OUT, "utf-8");
  } catch {
    console.error(
      "✗ capability-status: docs/_generated/capability-graph.md missing; run bun run docs:capability-status",
    );
    process.exit(1);
  }
  if (currentGraphMd !== graphMd) {
    console.error(
      "✗ capability-status: docs/_generated/capability-graph.md drift detected; run bun run docs:capability-status",
    );
    process.exit(1);
  }
  console.log("✓ capability-status: in sync (json + capability-graph.md)");
}

main();
