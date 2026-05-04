---
title: Package Dependencies
description: How the agents-js workspace packages depend on each other.
---

# Package Dependencies

The agents-js package graph is generated from workspace `package.json` manifests and published as a static JSON payload that agents and scripts can consume without rendering anything.

## Get the graph

The raw payload is published as [`/graph.json`](/graph.json) — internal `@agents-js/*` edges, external deps bucketed separately, peer-deps captured, reverse edges computed. No source-level import scan; this is the package-level DAG.

## Regenerate locally

After adding a package or moving a dependency:

```bash
bun run scripts/dep-graph-gen.ts
# wrote docs/public/graph.json — N packages (M publishable)
```

The generator walks `packages/*/package.json` and `apps/*/package.json`, buckets each `dependencies` entry as internal (`@agents-js/*`) or external, and computes reverse edges in a second pass.

## What's in the payload

- `package_count` and `publishable_count` — calculated counts from the current manifests.
- `packages` — array of `{ name, dir, private, version, internal_deps, external_deps, external_peer, exports_count }`.
- `reverse_edges` — for each package, the list of packages that depend on it.

Pipe into [`jq`](https://jqlang.org/), [`dot`](https://graphviz.org/), or your visualization tool of choice.

## Hoisted mermaid transitives — do not delete

Root `devDependencies` carries entries that nothing in our source code imports directly: `@braintree/sanitize-url`, `cytoscape`, `cytoscape-cose-bilkent`, `dayjs`, `debug`. They are transitive dependencies of `mermaid` (via `vitepress-plugin-mermaid`) that the plugin lists in its internal `optimizeDeps.include`. Vite's dev-mode pre-bundler resolves `optimizeDeps.include` entries from the project's top-level `node_modules/<pkg>/`. Bun's flattened layout stores them at `node_modules/.bun/<pkg>@<version>/node_modules/<pkg>/` instead, which Vite's resolver can reach for runtime imports but not for the pre-bundler's resolution pass — so dev mode logs `Failed to resolve dependency: <pkg>, present in 'optimizeDeps.include'` and the page never hydrates. Declaring them at root forces Bun to hoist them to top-level, which Vite's pre-bundler can find.

Production builds (rolldown) handle CJS interop natively and do not need this. Only `bun run docs:dev` does. If you trim devDeps and the dev server starts emitting `Failed to resolve dependency` warnings against any of these names, restore the entry rather than chasing the symptom.

## Where to go next

- The package map (what each package does) → [Primitives → Package Map](/primitives#package-map)
- Architecture layers (host / gateway / runtime) → [Protocols Primer](/protocols-primer)
