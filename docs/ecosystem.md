---
title: Ecosystem Map
diataxis: explanation
outline: [2, 3]
---

# Ecosystem Map

Capability map for agents-js. Shows demonstrated, undemonstrated, over-claimed,
and missing surfaces based on current evidence.

> **Status:** useful and improving — not yet canonical. Each tier reflects
> current evidence; see [How this stays honest](#how-this-stays-honest).

Tiers:

- **Demonstrated** — reproducible proof or current runtime/visual evidence.
- **Undemonstrated** — built and tested, but no captured user-facing workflow yet.
- **Over-claimed** — asserts more than the current implementation supports.
- **Missing** — named, but not built.

::: warning Trust posture & limitations (current, not future-state)

- **Registry is trusted-network-only.** No public-internet hardening unless explicitly proven and labeled; default assumption is same-network membership.
- **MCP bridge assumes stdio + gateway-relative addressing.** Authenticating bridges to the public internet is not supported in this configuration.
- **Gateway runs single-tenant per process.** Multi-tenant isolation is not implemented — run one gateway per trust boundary.
- **Trust-derived routing with env override (AJS-65, landed).** Dispatch routing derives from signed peer-records (the trust-derived target directory); `AGENTS_MCP_TARGETS_JSON`, if set, layers on top as an explicit per-target override (env wins; the trust-derived entry is the fallback base). Keep the two consistent — an env override silently shadows the trust-derived entry for that target.
- **Registry/card auth boundary.** Agent cards are public-readable; minting credentials are gopass-gated and short-lived (JWT TTL 900s).
- **No persistent revocation.** Identity revocation requires re-signing the trust manifest plus hot-reload; there is no central revocation-list service.

:::

<DocsCapabilityMap />

## How this stays honest

The classification lives in `scripts/capability-status.json` (tier authority is
the capability-reconciliation audit). A generator (`scripts/capability-status.ts`)
joins it against the dependency graph (`docs/public/graph.json`), fails if a
referenced package does not exist, and never infers a tier. The output
(`docs/public/capability-status.json`) is drift-gated by `bun run check`, so the
map cannot silently diverge from the package surface.

## Reading the map

- A capability can span several packages; the chips on each card list them.
- Use the tier filter chips to narrow the grid.
- "Undemonstrated" is not a criticism — much of the substrate is well tested and
  simply has no captured workflow yet. The gap this surfaces is demonstration,
  not correctness.

## Dependency graph

Each node is a package; edges are internal dependencies.

> Node color = the **worst** capability tier among the capabilities a package
> implements. Grey = no capability claim. A Demonstrated (green) node does **not**
> mean every capability in the package is Demonstrated.

!!!include(_generated/capability-graph.md)!!!
