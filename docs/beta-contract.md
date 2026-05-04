---
title: Beta Contract
---

# Beta Contract

> **Status:** Beta · **Validated by:** every other status badge in this site points back here · **Known limitations:** documented per-page in each "Known limitations" line

This page is the canonical statement of what "beta" means for `agents-js`. Every other status badge, version pin, and release-claim line in the docs reduces to this page.

## The contract

> *"All packages ship as beta. Patch releases may include known limitations. A patch should not ship with an unacknowledged regression in the declared beta workflow."*

That's the whole shape. The rest of this page expands each clause.

## All packages ship as beta

Every publishable `@agents-js/*` package ships under one beta status. There is **no** per-package tier split — no Stable / RC / Preview / Experimental classifications, no internal-vs-external split, no private-vs-public split.

If a package is in the [Package Map](/primitives#package-map), it is beta. If it builds and we publish it, it is beta. If it has rough edges, those rough edges are documented on the relevant page under "Known limitations" — they do not promote the package to a different tier.

The `0.2.0-beta-N` train is the version we ship under. The patch number increments on every release. There is no separate "stable" or "RC" version stream.

## Patch releases may include known limitations

A known limitation is a documented gap in the current implementation. Examples that are currently in beta with documented limitations:

- AG-UI run resumption across reconnects (see [Streaming and Events → Deliberate limits](/streaming-and-events#deliberate-limits))
- A2UI user → agent back-channel contract (currently namespaced `CUSTOM` event; see [Streaming and Events → Deliberate limits](/streaming-and-events#deliberate-limits) and [Protocols → A2UI](/protocols#a2ui))
- Agent Registry trusted-network posture (no auth, no schema validation, no ACL — see banner on [Surfaces → Agent Registry](/surfaces#agent-registry))
- Third-party A2A interop (not yet broadly tested)

These are real gaps. They ship in beta. They get fixed in subsequent beta patches. They are not feature-tier downgrades.

The rule for a known limitation:

1. It is documented on the relevant page's "Known limitations" line, or in a deliberate-limits section.
2. It is acknowledged before publication, not discovered after.
3. It does not silently break a workflow the docs claim works.

## A patch should not ship with an unacknowledged regression in the declared beta workflow

This is the publication gate. Bugs are bugs and they get fixed in the next patch — they do not create new release tiers. **But** regressions in the declared beta path block publication until they are fixed or explicitly converted into documented known limitations.

The declared beta path is what the docs claim works. Today that includes:

- the [source quickstart](/getting-started#quickstart-commands) on the landing
- the [Browser surface](/surfaces#browser) flow (connect dialog → connected chat → transcript)
- the [CLI surface](/surfaces#cli) flow (`serve` + `client`)
- the [host-embedding](/harness-guide) contract (`@agents-js/acp-host` orchestration surface)
- the [protocols](/protocols) the gateway and client implement (ACP, A2A, MCP-bridge, AG-UI, A2UI, JSON-RPC)
- the [streaming guarantees](/streaming-and-events) on `message/stream` and `tasks/resubscribe`
- the [concurrency model](/streaming-and-events#concurrency-boundary-summary) on the five gateway request paths

If a change to one of those breaks the documented behavior and that break is not acknowledged in the same change as a known limitation, the patch should not ship. Either fix the regression or document it as a known limitation, then publish.

## Quality bar — browser-first

The browser surface is the quality bar. Reasoning: it is the fastest path for a new user to understand the product, it is the most visible quality surface, and it exercises the gateway, runtime selection, streaming, elicitation, auth-required state, A2UI rendering, and the debug UX in one place. The CLI surface stays reliable; the browser surface is the visible quality bar against which beta patches are measured.

Practically:

- A regression in the browser surface flow blocks a patch unless documented as a known limitation.
- A regression in the CLI surface flow blocks a patch unless documented as a known limitation.
- A regression in another surface is a bug to fix in a subsequent patch (still beta, no tier change).

## Trust posture — local operator first

The default trust posture is **local operator on a trusted private network**.
The gateway can run wherever the operator chooses, but the current beta surface
does not claim public-network hardening by default.

Auth hardening for public-network operation (bearer tokens, mTLS, registry validation, redaction policy beyond the existing scope) is **not** in the current beta claim. It is explicitly deferred until the local-operator browser surface, fixture proof, and registry hardening land first. The Agent Registry trusted-network banner on [Surfaces → Agent Registry](/surfaces#agent-registry) is the cite for this posture.

The embedder seam (`@agents-js/a2ui-host/acp-host`'s `HostSurfaceAdapter`, `acp-host` policy + storage adapters, and the host contract on the [Harness Guide](/harness-guide)) is a first-class contract today. It hardens through local-operator proof surface before being broadly marketed as an embedder SDK.

## What this contract replaces

This page consolidates and supersedes earlier scattered release-status language across the docs:

- the prior "Mixed RC / Preview" badge on [Primitives](/primitives)
- the per-package Status column previously shown in the Package Map
- the "Package Stability Tiers" section previously in [Contribute](/develop/contribute)
- the "Promotion Criteria (Preview → RC, RC → Stable)" subsection previously in [Contribute](/develop/contribute)
- assorted "Preview" and "RC" status-badge wording previously on individual pages

Per-page status badges are still present on each major page. They all read **Beta** and they all point back here for the contract definition.

## How known limitations get tracked

A known limitation lives in two places:

1. **The page that documents the affected workflow** — under "Known limitations" in the page's status badge, or in a dedicated section like [Streaming and Events → Deliberate limits](/streaming-and-events#deliberate-limits).
2. **In the issue tracker** if it has an active fix lane.

A known limitation is removed from the docs when the fix lands and the regression test covers the previously-broken path.

## Patch cadence

Patches ship as `0.2.0-beta-N` increments. The release operator runbook is internal and lives in repo-internal context, not on the docs site. Each patch:

- bumps the publishable manifest versions
- ships every package in the [Package Map](/primitives#package-map) under the same version
- records what's new and what's a known limitation in the release notes

There is no separate stable or RC train. There is one beta train and the patch number increments.

## Non-goals

What `agents-js` is **not**, and is not building toward:

- **Not a framework.** It ships primitives, not a framework. Every package does one thing well and can be used independently. There is no "app framework" layer that requires you to buy into the full stack.
- **Not an agent runtime.** It does not build LLM inference, tool execution, or prompt management. It wraps existing runtimes (Claude, Gemini, OpenCode, etc.) via ACP and exposes them over A2A.
- **Not a protocol spec body.** It implements existing protocols (ACP, A2A, MCP, AG-UI, A2UI, JSON-RPC). It does not define new ones. When a protocol gap exists, the path is upstream contribution, not a fork.
- **Not a hosted service.** Everything runs locally or on infrastructure you control. No SaaS dependency. No telemetry phone-home. No cloud requirement.
- **Not a multi-tenant platform.** Single-user by design. Multi-agent, not multi-user. The permission model is per-session, not per-tenant.

## Cross-links

- [Primitives → Package Map](/primitives#package-map) — the canonical package list
- [Streaming, Events, and Concurrency → Deliberate limits](/streaming-and-events#deliberate-limits) — the canonical known-limitations list
- [Surfaces → Agent Registry](/surfaces#agent-registry) — the canonical trusted-network posture
