---
title: Architecture
outline: [2, 3]
---

# Architecture

The cross-application picture has three layers: a **Host** that owns the
human's conversation and runs middleware, a **Gateway** that translates
A2A ↔ ACP without opinions, and a **Remote Agent** that's just an ACP
process. Pan, zoom, or click a node for details.

<DocsArchitectureMap />

## Reading the diagram

- **Dashed groups** are layers — conceptual containers, not deployable
  units. Each layer's box lists its responsibilities (what it owns) and
  examples (what implementations exist or are planned).
- **Solid arrows** are protocol edges. Their labels name the wire
  protocol (`A2A over HTTP / Matrix / WS / in-process`,
  `ACP stdio / WS`).
- **Colors** mirror the layer's role:
  blue (`brand`) for the user-facing **Host**,
  amber (`warning`) for the protocol-bridge **Gateway**,
  green (`success`) for the autonomous **Agent**.
- **Click a text card** to open the inspector with the node's raw markdown
  and its canvas coordinates — useful when authoring or auditing the
  source at `docs/public/architecture.canvas`.

The boundaries are deliberate. The host knows about users; the agent
knows about protocols; the gateway sits in between and pretends not to
care about either. See [Primitives](./primitives) for the package-level
responsibilities of each layer and the `Provider` / `Transport` /
`Adapter` ports that compose them.
