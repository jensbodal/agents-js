import fs from "node:fs";
import path from "node:path";
import markdownItInclude from "markdown-it-include";
import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

// ─────────────────────────────────────────────────────────────────────────────
// Drift gate: VitePress dead-link detection (first-class check)
// ─────────────────────────────────────────────────────────────────────────────
// VitePress's default `ignoreDeadLinks: false` is in effect (not overridden
// below). Any broken internal link — e.g. `[text](/nonexistent-page)` or a
// stale `#heading-anchor` — fails `bun run docs:build` with a
// `[vitepress] N dead link(s) found` error.
//
// This is our primary guard against docs drift: stale links, renamed pages,
// and bad heading anchors cannot reach the live site. It has already caught
// drift in practice (the "Obsidian agent" overclaim and the "Protocols and
// Schemas" heading anchor confusion), so treat it as load-bearing.
//
// DO NOT set `ignoreDeadLinks: true` (or add per-link exceptions) without a
// very explicit reason. If you need to allow an intentional off-tree link,
// prefer an allowlist entry (array form of `ignoreDeadLinks`) over a blanket
// disable, and leave a comment explaining why.
//
// Related drift gates: `scripts/docs-consistency.ts` (publishable-package
// version + docs-host URL parity). The two checks complement each other and
// both run as part of `bun run docs:build`.
// ─────────────────────────────────────────────────────────────────────────────

// biome-ignore lint/style/noProcessEnv: docs tunnel HMR override is an explicit local launcher contract
const tunnelHmrClientPort = Number.parseInt(process.env.DOCS_TUNNEL_HMR_CLIENT_PORT ?? "", 10);

let typedocSidebar = [];
try {
  const sidebarPath = path.resolve(__dirname, "../api/typedoc-sidebar.json");
  if (fs.existsSync(sidebarPath)) {
    typedocSidebar = JSON.parse(fs.readFileSync(sidebarPath, "utf-8"));
  }
} catch (_e) {
  console.warn("Could not load typedoc-sidebar.json");
}

export default withMermaid(
  defineConfig({
    title: "agents-js — Your agent. Everywhere.",
    description:
      "Expose any ACP agent over A2A. Connect from any terminal, browser, or tool. Route, mention, bridge to MCP, or embed managed sessions in your own host.",
    // Local working artifacts: archived plans live under `docs/superpowers/`
    // for orchestrator workflow tooling but should not ship as deployed
    // pages. Same for the api/ tree's regenerated typedoc-sidebar.json
    // (config-only, not a page). `_internal/**` is reserved as a build-time
    // exclusion guard so re-introduced session-research drafts never ship
    // to the public docs even if they reappear under that path.
    srcExclude: ["superpowers/**", "_internal/**"],
    markdown: {
      // Resolve `!!!include(path)!!!` directives relative to docs/ root so
      // hand-authored pages can transclude generated reference partials
      // emitted by `scripts/docs-reference.ts`. See `docs/_generated/README.md`
      // for the partial schema and regeneration command.
      config(md) {
        md.use(markdownItInclude, {
          root: path.resolve(__dirname, ".."),
          throwError: true,
          // Anchor the directive to the start of a line so inline `!!!include(...)!!!`
          // examples in prose (e.g. inside code spans, list-item continuations) are
          // not processed. Real include directives in hand-authored pages always
          // appear at column 0 on their own line.
          includeRe: /^!{3}\s*include(\([^)\n]+\))!{3}\s*$/m,
        });
      },
    },
    vite: {
      // The docs theme imports a Lit element (`docs-meta-agent.ts`) that uses
      // TC39 decorators + accessor syntax. esbuild's default target predates
      // those features and would emit a parse error. Bumping the target to
      // es2022 lets esbuild transform decorators and accessor down-level.
      // Mirrors the same fix in apps/web-ui/vite.config.ts.
      esbuild: {
        target: "es2022",
      },
      server: {
        allowedHosts: true,
        host: "127.0.0.1",
        ...(Number.isFinite(tunnelHmrClientPort)
          ? {
              hmr: {
                clientPort: tunnelHmrClientPort,
              },
            }
          : {}),
      },
    },
    themeConfig: {
      nav: [
        { text: "Get Started", link: "/getting-started" },
        { text: "Playground", link: "/playground" },
        { text: "How It Works", link: "/protocols-primer" },
        { text: "Surfaces", link: "/surfaces" },
        { text: "Build", link: "/primitives" },
        { text: "Reference", link: "/protocols" },
        {
          text: "Develop",
          items: [
            { text: "Contribute", link: "/develop/contribute" },
            { text: "Browser Entry Points", link: "/develop/browser-entry-points" },
          ],
        },
      ],
      sidebar: {
        "/api/": typedocSidebar,
        "/": [
          {
            text: "Use agents-js",
            items: [
              { text: "Home", link: "/" },
              { text: "Getting Started", link: "/getting-started" },
              { text: "Playground", link: "/playground" },
              { text: "Protocols Primer", link: "/protocols-primer" },
              { text: "Surfaces", link: "/surfaces" },
            ],
          },
          {
            text: "Build With agents-js",
            items: [
              { text: "Primitives", link: "/primitives" },
              { text: "Architecture", link: "/architecture" },
              { text: "Hosted MCP Tool Surface", link: "/hosted-mcp-tool-surface" },
              { text: "Harness Guide", link: "/harness-guide" },
              { text: "Protocols", link: "/protocols" },
              { text: "Streaming, Events, and Concurrency", link: "/streaming-and-events" },
              { text: "Observability", link: "/observability" },
              { text: "API Reference", link: "/api/" },
            ],
          },
          {
            text: "Develop",
            items: [
              { text: "Contribute", link: "/develop/contribute" },
              { text: "Browser Entry Points", link: "/develop/browser-entry-points" },
              { text: "Dependencies", link: "/develop/dependencies" },
              { text: "Playground Smoke", link: "/develop/playground-smoke" },
            ],
          },
        ],
      },
    },
  }),
  {
    mermaid: {
      theme: "base",
      themeVariables: {
        primaryColor: "#3c8772",
        primaryTextColor: "#ffffff",
        primaryBorderColor: "#2c6454",
        lineColor: "#476582",
        secondaryColor: "#e0f2e9",
        tertiaryColor: "#f6f8fa",
        textColor: "#213547",
        mainBkg: "#3c8772",
        nodeBorder: "#2c6454",
        clusterBkg: "#f6f8fa",
      },
      startOnLoad: false,
      securityLevel: "loose",
    },
    mermaidPlugin: {
      class: "agents-js-diagram",
    },
  },
);
