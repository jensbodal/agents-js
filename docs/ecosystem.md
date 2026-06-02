---
title: Ecosystem Map
diataxis: explanation
outline: [2, 3]
---

# Ecosystem Map

What does agents-js actually do today — and how do we know? This map renders
the capability reconciliation as data, graded on a single question: **can a
human see it work?**, not "is there a test?". Each capability carries an
evidence tier:

- **Demonstrated** — someone has run it first-hand (a command, an example).
- **Undemonstrated** — built and tested, but no captured human-visible proof yet.
- **Over-claimed** — the docs or vision assert more than currently exists.
- **Missing** — named, but not built.

The cards below are rendered by `acp-capability-card` — a real
`@agents-js/ui-components` web component on the shared design system. The page
is itself a small act of dogfooding: agents-js's own UI, visualizing agents-js.

<DocsCapabilityMap />

## How this stays honest

The classification lives in `scripts/capability-status.json` (tier authority is
the capability-reconciliation effort). A generator
(`scripts/capability-status.ts`) joins it against the dependency graph
(`docs/public/graph.json`), **fails loudly if any referenced package does not
exist**, and never infers a tier on its own. The output
(`docs/public/capability-status.json`) is drift-gated by `bun run check`, so the
map cannot silently diverge from the package surface.

## Reading the map

- A capability can span several packages; the chips on each card list them.
- Use the tier filter chips to narrow the grid.
- "Undemonstrated" is not a criticism — much of the substrate is robustly
  tested and simply has no captured demo yet. The honest gap this map surfaces
  is **demonstration**, not correctness.
