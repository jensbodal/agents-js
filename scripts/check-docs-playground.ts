#!/usr/bin/env bun

/**
 * Build-time smoke for the /playground page.
 *
 * Asserts:
 *   - docs/playground.md exists and embeds <DocsMetaAgent />
 *   - the built docs corpus exists and has at least one entry (auto-builds
 *     if missing, so `bun run check` stays self-contained)
 *   - the static VitePress build produced an HTML page for /playground that
 *     references the custom element placeholder (ClientOnly emits the slot
 *     content as a server-side hydration anchor).
 *
 * This does NOT launch a browser. Real-browser smoke is tracked as a deferred
 * follow-up modeled on scripts/browser-smoke.ts.
 *
 * Wiring: this script is included in `bun run check`. Corpus build is
 * triggered lazily here (not as a separate check-chain step) so a clean
 * checkout doesn't fail on a missing corpus artifact. The dist/ HTML check
 * gracefully skips when the artifact is absent — run
 * `bun run docs:build && bun run docs:smoke` to exercise the full check.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

interface Check {
  name: string;
  run: () => string | null | "skip"; // null on success, error string on failure, "skip" to skip with the message printed by run()
}

function ensureCorpus(): string | null {
  const corpusPath = join(REPO, "docs", "public", "docs-index.json");
  // Build if missing OR if any markdown source is newer than the corpus —
  // catches the "I edited docs/foo.md but forgot docs:index" footgun.
  let needsBuild = !existsSync(corpusPath);
  if (!needsBuild) {
    const corpusMtime = statSync(corpusPath).mtimeMs;
    const docsMd = Bun.spawnSync([
      "find",
      join(REPO, "docs"),
      "-name",
      "*.md",
      "-not",
      "-path",
      "*/api/*",
    ]);
    const newest = docsMd.stdout
      .toString()
      .split("\n")
      .filter((p) => p)
      .reduce((max, p) => Math.max(max, statSync(p).mtimeMs), 0);
    needsBuild = newest > corpusMtime;
  }
  if (needsBuild) {
    console.log("  (building corpus via scripts/build-docs-index.ts)");
    const result = spawnSync("bun", [join(REPO, "scripts", "build-docs-index.ts")], {
      stdio: "inherit",
    });
    if (result.status !== 0) return "corpus build failed";
  }
  return null;
}

const checks: Check[] = [
  {
    name: "docs/playground.md embeds <DocsMetaAgent />",
    run: () => {
      const path = join(REPO, "docs", "playground.md");
      if (!existsSync(path)) return `missing ${path}`;
      const md = readFileSync(path, "utf8");
      if (!md.includes("<DocsMetaAgent")) return `${path} does not include <DocsMetaAgent`;
      return null;
    },
  },
  {
    name: "docs corpus has entries",
    run: () => {
      const buildErr = ensureCorpus();
      if (buildErr) return buildErr;
      const path = join(REPO, "docs", "public", "docs-index.json");
      const corpus = JSON.parse(readFileSync(path, "utf8")) as { entries?: unknown[] };
      if (!corpus.entries || corpus.entries.length === 0) return `${path} has no entries`;
      return null;
    },
  },
  {
    name: "VitePress build emitted /playground.html with the DocsMetaAgent component reference",
    run: () => {
      const distDir = join(REPO, "docs", ".vitepress", "dist");
      const htmlPath = join(distDir, "playground.html");
      if (!existsSync(htmlPath)) {
        console.log(`  (skipped — run 'bun run docs:build' to enable HTML check)`);
        return "skip";
      }
      // The custom element renders client-side via `<ClientOnly>` and never
      // appears in the SSR HTML body. The Vue component name (`DocsMetaAgent`)
      // does land in the playground module bundle though, so we walk the
      // asset chunks for it.
      const html = readFileSync(htmlPath, "utf8");
      const assetMatch = html.match(/playground\.md\.[A-Za-z0-9_-]+\.lean\.js/);
      if (!assetMatch) {
        return `${htmlPath} does not reference a playground.md.* asset bundle`;
      }
      const assetPath = join(distDir, "assets", assetMatch[0]);
      if (!existsSync(assetPath)) {
        return `expected asset ${assetPath} to exist (referenced by playground.html)`;
      }
      const asset = readFileSync(assetPath, "utf8");
      if (!asset.includes("DocsMetaAgent")) {
        return `${assetPath} does not reference the DocsMetaAgent component`;
      }
      return null;
    },
  },
  {
    name: "Playground v2 M2 element source registers <docs-playground-shell>",
    run: () => {
      const path = join(
        REPO,
        "docs",
        ".vitepress",
        "theme",
        "components",
        "docs-playground-shell.ts",
      );
      if (!existsSync(path)) return `missing ${path}`;
      const src = readFileSync(path, "utf8");
      // Both the decorator call and the global tag-name map declaration are
      // load-bearing; if either drifts the runtime surface breaks silently.
      if (!src.includes('safeCustomElement("docs-playground-shell")')) {
        return `${path} no longer calls safeCustomElement("docs-playground-shell")`;
      }
      if (!src.includes('"docs-playground-shell": DocsPlaygroundShell')) {
        return `${path} no longer declares the docs-playground-shell HTMLElementTagNameMap entry`;
      }
      return null;
    },
  },
  {
    name: "Playground v2 M3 element source registers <docs-trace-inspector>",
    run: () => {
      const inspectorPath = join(
        REPO,
        "docs",
        ".vitepress",
        "theme",
        "components",
        "docs-trace-inspector.ts",
      );
      if (!existsSync(inspectorPath)) return `missing ${inspectorPath}`;
      const inspectorSrc = readFileSync(inspectorPath, "utf8");
      if (!inspectorSrc.includes('safeCustomElement("docs-trace-inspector")')) {
        return `${inspectorPath} no longer calls safeCustomElement("docs-trace-inspector")`;
      }
      if (!inspectorSrc.includes('"docs-trace-inspector": DocsTraceInspector')) {
        return `${inspectorPath} no longer declares the docs-trace-inspector HTMLElementTagNameMap entry`;
      }
      // The shell must mount the inspector — otherwise the new element is
      // dead code. Mirror the existing dist HTML check's intent (custom
      // elements don't appear in SSR HTML, so we assert the source-level
      // mount instead).
      const shellPath = join(
        REPO,
        "docs",
        ".vitepress",
        "theme",
        "components",
        "docs-playground-shell.ts",
      );
      const shellSrc = readFileSync(shellPath, "utf8");
      if (!shellSrc.includes("<docs-trace-inspector")) {
        return `${shellPath} no longer mounts <docs-trace-inspector>`;
      }
      return null;
    },
  },
  {
    name: "Playground v2 M4 element source registers <docs-manifest-editor>",
    run: () => {
      const editorPath = join(
        REPO,
        "docs",
        ".vitepress",
        "theme",
        "components",
        "docs-manifest-editor.ts",
      );
      if (!existsSync(editorPath)) return `missing ${editorPath}`;
      const editorSrc = readFileSync(editorPath, "utf8");
      if (!editorSrc.includes('safeCustomElement("docs-manifest-editor")')) {
        return `${editorPath} no longer calls safeCustomElement("docs-manifest-editor")`;
      }
      if (!editorSrc.includes('"docs-manifest-editor": DocsManifestEditor')) {
        return `${editorPath} no longer declares the docs-manifest-editor HTMLElementTagNameMap entry`;
      }
      // Shell must mount the editor (both pre-activation and inside the
      // tabbed inspector). Mirror the trace-inspector smoke check.
      const shellPath = join(
        REPO,
        "docs",
        ".vitepress",
        "theme",
        "components",
        "docs-playground-shell.ts",
      );
      const shellSrc = readFileSync(shellPath, "utf8");
      if (!shellSrc.includes("<docs-manifest-editor")) {
        return `${shellPath} no longer mounts <docs-manifest-editor>`;
      }
      return null;
    },
  },
  {
    name: "Playground v2 element source registers <docs-chat-pane>",
    run: () => {
      const chatPath = join(REPO, "docs", ".vitepress", "theme", "components", "docs-chat-pane.ts");
      if (!existsSync(chatPath)) return `missing ${chatPath}`;
      const chatSrc = readFileSync(chatPath, "utf8");
      if (!chatSrc.includes('safeCustomElement("docs-chat-pane")')) {
        return `${chatPath} no longer calls safeCustomElement("docs-chat-pane")`;
      }
      if (!chatSrc.includes('"docs-chat-pane": DocsChatPane')) {
        return `${chatPath} no longer declares the docs-chat-pane HTMLElementTagNameMap entry`;
      }
      const shellPath = join(
        REPO,
        "docs",
        ".vitepress",
        "theme",
        "components",
        "docs-playground-shell.ts",
      );
      const shellSrc = readFileSync(shellPath, "utf8");
      if (!shellSrc.includes("<docs-chat-pane")) {
        return `${shellPath} no longer mounts <docs-chat-pane>`;
      }
      return null;
    },
  },
  {
    name: "Playground v2 element source registers <docs-run-controls>",
    run: () => {
      const controlsPath = join(
        REPO,
        "docs",
        ".vitepress",
        "theme",
        "components",
        "docs-run-controls.ts",
      );
      if (!existsSync(controlsPath)) return `missing ${controlsPath}`;
      const controlsSrc = readFileSync(controlsPath, "utf8");
      if (!controlsSrc.includes('safeCustomElement("docs-run-controls")')) {
        return `${controlsPath} no longer calls safeCustomElement("docs-run-controls")`;
      }
      if (!controlsSrc.includes('"docs-run-controls": DocsRunControls')) {
        return `${controlsPath} no longer declares the docs-run-controls HTMLElementTagNameMap entry`;
      }
      const shellPath = join(
        REPO,
        "docs",
        ".vitepress",
        "theme",
        "components",
        "docs-playground-shell.ts",
      );
      const shellSrc = readFileSync(shellPath, "utf8");
      if (!shellSrc.includes("<docs-run-controls")) {
        return `${shellPath} no longer mounts <docs-run-controls>`;
      }
      return null;
    },
  },
];

let failed = 0;
let skipped = 0;
for (const check of checks) {
  const result = check.run();
  if (result === "skip") {
    console.log(`~ ${check.name} (skipped)`);
    skipped++;
  } else if (result) {
    console.error(`✗ ${check.name}\n    ${result}`);
    failed++;
  } else {
    console.log(`✓ ${check.name}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log(
  `\nAll docs playground smoke checks passed${skipped > 0 ? ` (${skipped} skipped)` : ""}.`,
);
