#!/usr/bin/env bun
/**
 * Generate output/agents-js-dashboard.html from:
 *   - docs/public/graph.json         (per-package metadata + internal deps)
 *   - output/test-counts.json        (per-package test pass/fail/files)
 *   - output/dashboard-status.json   (human-authored status + notes per pkg)
 *
 * The dashboard groups packages into DAG layers (topological sort over
 * internal_deps), shows status badges, and counts tests. Status + notes are
 * the only hand-authored fields; everything else is regenerated.
 *
 * Usage:
 *   bun scripts/build-dashboard.ts
 *
 * Or via the chained `bun run dashboard` script which also runs
 * dep-graph-gen.ts and test-counts.ts first.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const GRAPH = resolve(REPO_ROOT, "docs/public/graph.json");
const TEST_COUNTS = resolve(REPO_ROOT, "output/test-counts.json");
const STATUS = resolve(REPO_ROOT, "scripts/dashboard-status.json");
const LOCAL_REFERENCE_TRACKING = resolve(
  REPO_ROOT,
  "plans/local-environment-reference-tracking.json",
);
const OUT = resolve(REPO_ROOT, "output/agents-js-dashboard.html");

const BASELINE_REF = "d505044";

type StatusKey = "pending" | "validating" | "validated" | "refactored" | "blocked";

interface GraphPkg {
  name: string;
  dir: string;
  private: boolean;
  version: string;
  internal_deps: string[];
}

interface TestCounts {
  packages: Record<
    string,
    {
      pass: number | null;
      fail: number | null;
      files: number | null;
      hasTestScript: boolean;
      summary: string | null;
    }
  >;
}

interface DashboardStatus {
  packages: Record<string, { status: StatusKey; notes: string }>;
}

interface LocalReferenceTrackingRow {
  file: string;
  total: number;
  counts: Record<string, number>;
}

interface LocalReferenceTracking {
  generatedAt?: string;
  scope?: string;
  terms: string[];
  rows: LocalReferenceTrackingRow[];
}

function classifyScope(dir: string): "core" | "extras" | "test" | "app" {
  if (dir.startsWith("packages/")) return "core";
  if (dir.startsWith("extras/")) return "extras";
  if (dir.startsWith("tests/")) return "test";
  return "app";
}

function topoLayers(packages: GraphPkg[]): string[][] {
  const named = new Set(packages.map((p) => p.name));
  const remaining = new Map(
    packages.map((p) => [p.name, new Set(p.internal_deps.filter((d) => named.has(d)))]),
  );
  const layers: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) {
      throw new Error(`Cycle in workspace deps among: ${[...remaining.keys()].join(", ")}`);
    }
    layers.push(ready);
    for (const name of ready) remaining.delete(name);
    for (const deps of remaining.values()) for (const r of ready) deps.delete(r);
  }
  return layers;
}

function describeLayer(index: number, total: number): { title: string; desc: string } {
  if (index === 0) {
    return {
      title: "Layer 0 — Leaves (no workspace deps)",
      desc: "Pure utilities and re-export packages. Validate first; everything else builds on these.",
    };
  }
  if (index === total - 1) {
    return {
      title: `Layer ${index} — Top-level entrypoint and test fixtures`,
      desc: "CLI binary and any test-fixture packages that close the dep chain.",
    };
  }
  return {
    title: `Layer ${index}`,
    desc: "Build on the layers below.",
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function gitCapture(args: string[]): string {
  const proc = Bun.spawnSync({
    cmd: ["git", "-C", REPO_ROOT, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return "";
  return new TextDecoder().decode(proc.stdout).trim();
}

function commitsSince(ref: string): number {
  const out = gitCapture(["log", "--oneline", `${ref}..HEAD`]);
  return out === "" ? 0 : out.split("\n").length;
}

function currentHeadShort(): string {
  return gitCapture(["rev-parse", "--short", "HEAD"]) || "unknown";
}

function renderTestCount(counts: TestCounts["packages"][string] | undefined): string {
  if (!counts) return "—";
  if (!counts.hasTestScript) return "no test script";
  if (counts.summary === null) return `error (exit ${counts.fail ?? "?"})`;
  if (counts.fail && counts.fail > 0) {
    return `${counts.pass}/${(counts.pass ?? 0) + (counts.fail ?? 0)} (${counts.fail} fail)`;
  }
  return `${counts.pass}`;
}

function readPackageDescription(dir: string): string {
  try {
    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, dir, "package.json"), "utf8"));
    return typeof manifest.description === "string" ? manifest.description : "";
  } catch {
    return "";
  }
}

function readLocalReferenceTracking(): LocalReferenceTracking | null {
  if (!existsSync(LOCAL_REFERENCE_TRACKING)) return null;

  const raw = JSON.parse(
    readFileSync(LOCAL_REFERENCE_TRACKING, "utf8"),
  ) as Partial<LocalReferenceTracking>;
  const rows = Array.isArray(raw.rows)
    ? raw.rows.filter(
        (row): row is LocalReferenceTrackingRow =>
          typeof row?.file === "string" &&
          typeof row.total === "number" &&
          row.counts !== null &&
          typeof row.counts === "object",
      )
    : [];

  if (rows.length === 0) return null;

  const terms =
    Array.isArray(raw.terms) && raw.terms.every((term) => typeof term === "string")
      ? raw.terms
      : [...new Set(rows.flatMap((row) => Object.keys(row.counts)))].sort();

  return {
    generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : undefined,
    scope: typeof raw.scope === "string" ? raw.scope : undefined,
    terms,
    rows: rows.toSorted((a, b) => b.total - a.total || a.file.localeCompare(b.file)),
  };
}

function renderRow(
  pkg: GraphPkg,
  testCounts: TestCounts["packages"][string] | undefined,
  status: { status: StatusKey; notes: string } | undefined,
): string {
  const scope = classifyScope(pkg.dir);
  const scopeLabel = scope === "test" ? "test" : scope;
  const statusKey: StatusKey = status?.status ?? "pending";
  const notes = status?.notes ?? "";
  const testText = renderTestCount(testCounts);
  const description = readPackageDescription(pkg.dir);

  return `
      <tr>
        <td class="pkg-name${pkg.private ? " private" : ""}">${escapeHtml(pkg.name)}</td>
        <td><span class="scope-tag ${scopeLabel}">${scopeLabel}</span></td>
        <td><span class="badge ${statusKey}">${statusKey}</span></td>
        <td class="pkg-purpose">${escapeHtml(description)}</td>
        <td class="pkg-tests">${escapeHtml(testText)}</td>
        <td class="pkg-notes">${escapeHtml(notes)}</td>
      </tr>`;
}

function renderLocalReferenceTracking(tracking: LocalReferenceTracking | null): string {
  if (!tracking) return "";

  const totalMatches = tracking.rows.reduce((sum, row) => sum + row.total, 0);
  const termHeaders = tracking.terms
    .map((term) => `<th class="local-num">${escapeHtml(term)}</th>`)
    .join("");
  const rows = tracking.rows
    .map((row) => {
      const termCells = tracking.terms
        .map((term) => `<td class="local-num">${row.counts[term] ?? 0}</td>`)
        .join("");
      return `
      <tr>
        <td class="local-file"><code>${escapeHtml(row.file)}</code></td>
        <td class="local-num local-total">${row.total}</td>
        ${termCells}
      </tr>`;
    })
    .join("");

  return `
<section class="local-reference">
  <div class="section-head">
    <div>
      <h2>Local Reference Cleanup</h2>
      <div class="section-desc">Local-only document scan for environment-specific references, sorted by total hits.</div>
    </div>
    <div class="section-metrics">
      <span><strong>${tracking.rows.length}</strong> files</span>
      <span><strong>${totalMatches}</strong> hits</span>
    </div>
  </div>
  <div class="section-meta">
    <span><strong>Generated:</strong> ${escapeHtml(tracking.generatedAt ?? "unknown")}</span>
    <span><strong>Scope:</strong> ${escapeHtml(tracking.scope ?? "document-like files")}</span>
    <span><strong>Source:</strong> <code>plans/local-environment-reference-tracking.json</code></span>
  </div>
  <table class="local-ref-table">
    <thead><tr>
      <th>File</th>
      <th class="local-num">Total</th>
      ${termHeaders}
    </tr></thead>
    <tbody>${rows}
    </tbody>
  </table>
</section>`;
}

function renderDashboard(
  layers: string[][],
  packages: Map<string, GraphPkg>,
  testCounts: TestCounts,
  status: DashboardStatus,
  localReferenceTracking: LocalReferenceTracking | null,
): string {
  const allPackages = [...packages.values()];
  const counts = {
    total: allPackages.length,
    core: allPackages.filter((p) => classifyScope(p.dir) === "core").length,
    extras: allPackages.filter((p) => classifyScope(p.dir) === "extras").length,
    test: allPackages.filter((p) => classifyScope(p.dir) === "test").length,
    validated: Object.values(status.packages).filter((s) => s.status === "validated").length,
    pending: Object.values(status.packages).filter(
      (s) => s.status === "pending" || s.status === "validating",
    ).length,
  };

  const layerHtml = layers
    .map((layer, index) => {
      const { title, desc } = describeLayer(index, layers.length);
      const rows = layer
        .map((name) => {
          const pkg = packages.get(name);
          if (!pkg) return "";
          return renderRow(pkg, testCounts.packages[name], status.packages[name]);
        })
        .join("");
      return `
<div class="layer">
  <h2>${escapeHtml(title)}</h2>
  <div class="layer-desc">${escapeHtml(desc)}</div>
  <table class="pkg-table">
    <thead><tr>
      <th style="width: 200px;">Package</th>
      <th style="width: 60px;">Scope</th>
      <th style="width: 100px;">Status</th>
      <th>Purpose</th>
      <th style="width: 110px;">Tests</th>
      <th style="width: 220px;">Notes</th>
    </tr></thead>
    <tbody>${rows}
    </tbody>
  </table>
</div>`;
    })
    .join("");
  const localReferenceHtml = renderLocalReferenceTracking(localReferenceTracking);
  const sourceText = `scripts/dashboard-status.json + docs/public/graph.json + output/test-counts.json${
    localReferenceTracking ? " + plans/local-environment-reference-tracking.json" : ""
  }`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>agents-js — Validation Dashboard</title>
<style>
  :root {
    --bg: #0e1116; --panel: #161b22; --panel-2: #1f2530;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --good: #3fb950; --warn: #d29922; --bad: #f85149; --info: #79c0ff;
    --line: #30363d;
    --pending: #6e7681; --validating: #d29922; --validated: #3fb950;
    --refactored: #79c0ff; --blocked: #f85149;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; background: var(--bg); color: var(--text); }
  header { padding: 24px 32px 16px; border-bottom: 1px solid var(--line); background: linear-gradient(180deg, #0e1116 0%, #161b22 100%); }
  header h1 { margin: 0 0 6px; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
  header .sub { color: var(--muted); font-size: 12px; }
  header .meta { margin-top: 12px; display: flex; gap: 24px; font-size: 12px; color: var(--muted); flex-wrap: wrap; }
  header .meta strong { color: var(--text); font-weight: 500; }
  main { padding: 24px 32px 64px; max-width: 1400px; margin: 0 auto; }
  .legend { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 24px; font-size: 11px; }
  .legend .badge { font-size: 10px; padding: 3px 8px; }
  .summary-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; margin-bottom: 32px; }
  .summary-row .cell { padding: 12px 14px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
  .summary-row .cell .num { font-size: 22px; font-weight: 600; line-height: 1; }
  .summary-row .cell .lbl { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin-top: 4px; }
  .layer { margin-bottom: 32px; }
  .layer h2 { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--accent); text-transform: uppercase; letter-spacing: 0.08em; }
  .layer .layer-desc { color: var(--muted); font-size: 12px; margin-bottom: 12px; }
  .pkg-table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
  .pkg-table th { text-align: left; background: var(--panel-2); padding: 8px 12px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 500; border-bottom: 1px solid var(--line); }
  .pkg-table td { padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .pkg-table tr:last-child td { border-bottom: 0; }
  .pkg-table tr:hover td { background: var(--panel-2); }
  .pkg-table .pkg-name { font-weight: 500; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; white-space: nowrap; }
  .pkg-table .pkg-name.private::after { content: "private"; margin-left: 8px; font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 400; font-family: -apple-system, sans-serif; border: 1px solid var(--line); padding: 1px 5px; border-radius: 3px; }
  .pkg-table .pkg-purpose { color: var(--muted); font-size: 12px; max-width: 480px; }
  .pkg-table .pkg-tests { font-family: ui-monospace, monospace; font-size: 12px; color: var(--text); white-space: nowrap; }
  .pkg-table .pkg-notes { color: var(--text); font-size: 12px; max-width: 320px; }
  .badge { display: inline-block; padding: 2px 8px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-radius: 3px; color: #fff; }
  .badge.pending { background: var(--pending); }
  .badge.validating { background: var(--validating); color: #1c2128; }
  .badge.validated { background: var(--validated); color: #1c2128; }
  .badge.refactored { background: var(--refactored); color: #1c2128; }
  .badge.blocked { background: var(--blocked); }
  footer { padding: 24px 32px; color: var(--muted); font-size: 11px; border-top: 1px solid var(--line); margin-top: 32px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: var(--panel-2); padding: 1px 5px; border-radius: 3px; }
  .scope-tag { display: inline-block; font-size: 9px; padding: 1px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 500; }
  .scope-tag.core { background: rgba(88, 166, 255, 0.15); color: var(--accent); border: 1px solid rgba(88, 166, 255, 0.3); }
  .scope-tag.extras { background: rgba(210, 153, 34, 0.15); color: var(--warn); border: 1px solid rgba(210, 153, 34, 0.3); }
  .scope-tag.test { background: rgba(139, 148, 158, 0.15); color: var(--muted); border: 1px solid rgba(139, 148, 158, 0.3); }
  .local-reference { margin-bottom: 32px; padding: 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; overflow-x: auto; }
  .section-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 8px; }
  .section-head h2 { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--warn); text-transform: uppercase; letter-spacing: 0.08em; }
  .section-desc, .section-meta { color: var(--muted); font-size: 12px; }
  .section-meta { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 12px; }
  .section-meta strong, .section-metrics strong { color: var(--text); font-weight: 600; }
  .section-metrics { display: flex; gap: 12px; color: var(--muted); font-size: 12px; white-space: nowrap; }
  .local-ref-table { width: 100%; min-width: 960px; border-collapse: collapse; }
  .local-ref-table th { text-align: left; background: var(--panel-2); padding: 7px 10px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 500; border-bottom: 1px solid var(--line); }
  .local-ref-table td { padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; font-size: 12px; }
  .local-ref-table tr:last-child td { border-bottom: 0; }
  .local-ref-table tr:hover td { background: var(--panel-2); }
  .local-ref-table .local-file code { background: transparent; padding: 0; }
  .local-ref-table .local-num { text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
  .local-ref-table .local-total { color: var(--warn); font-weight: 700; }
</style>
</head>
<body>
<header>
  <h1>agents-js — Validation Dashboard</h1>
  <div class="sub">DAG-ordered package-by-package validation. Each package's purpose is the source of truth; tests get refactored as needed to align.</div>
  <div class="meta">
    <span><strong>Generated:</strong> ${new Date().toISOString()}</span>
    <span><strong>main HEAD:</strong> ${currentHeadShort()}</span>
    <span><strong>Commits since ${BASELINE_REF}:</strong> ${commitsSince(BASELINE_REF)}</span>
    <span><strong>Source:</strong> ${escapeHtml(sourceText)}</span>
  </div>
</header>

<main>

<div class="legend">
  <span class="badge pending">pending</span>
  <span class="badge validating">validating</span>
  <span class="badge validated">validated</span>
  <span class="badge refactored">refactored</span>
  <span class="badge blocked">blocked</span>
</div>

<div class="summary-row">
  <div class="cell"><div class="num">${counts.total}</div><div class="lbl">Total packages</div></div>
  <div class="cell"><div class="num">${counts.core}</div><div class="lbl">Core (packages/)</div></div>
  <div class="cell"><div class="num">${counts.extras}</div><div class="lbl">Extras</div></div>
  <div class="cell"><div class="num">${counts.test}</div><div class="lbl">Test fixture</div></div>
  <div class="cell"><div class="num">${counts.validated}</div><div class="lbl">Validated</div></div>
  <div class="cell"><div class="num">${counts.pending}</div><div class="lbl">Pending / validating</div></div>
</div>
${localReferenceHtml}
${layerHtml}

</main>

<footer>
  <div>Status workflow: <strong>pending</strong> → <strong>validating</strong> → (<strong>refactored</strong> if tests changed) → <strong>validated</strong>. <strong>blocked</strong> if a real defect is uncovered.</div>
  <div style="margin-top: 6px;">Approach per package: read README + JSDoc + index exports → audit tests against stated purpose → keep / refactor / remove / add → run focused suite → mark status in <code>scripts/dashboard-status.json</code> → re-run <code>bun run dashboard</code>.</div>
  <div style="margin-top: 6px;">Generators: <code>scripts/dep-graph-gen.ts</code>, <code>scripts/test-counts.ts</code>, <code>scripts/build-dashboard.ts</code>.</div>
</footer>

</body>
</html>
`;
}

async function main() {
  const graph = JSON.parse(readFileSync(GRAPH, "utf8")) as { packages: GraphPkg[] };
  const testCounts = JSON.parse(readFileSync(TEST_COUNTS, "utf8")) as TestCounts;
  const status = JSON.parse(readFileSync(STATUS, "utf8")) as DashboardStatus;
  const localReferenceTracking = readLocalReferenceTracking();

  // Filter to dashboard scope: packages/, extras/, tests/trial-agent (not apps/).
  const inScope = graph.packages.filter((p) => !p.dir.startsWith("apps/"));
  const byName = new Map(inScope.map((p) => [p.name, p]));

  const layers = topoLayers(inScope);
  const out = renderDashboard(layers, byName, testCounts, status, localReferenceTracking);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, out);
  process.stdout.write(`[build-dashboard] wrote ${OUT}\n`);
}

await main();
