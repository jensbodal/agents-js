---
title: ADR — Browser-Native Docs Meta-Agent
---

# ADR: Browser-Native Docs Meta-Agent

## Context

We want an interactive agent embedded in the docs that lets visitors ask questions of the agents-js corpus without standing up a backend. WebGPU + WebLLM has matured enough to run small instruct models locally in the browser, while ACP and A2A semantics give us a familiar session boundary.

## Decision

Ship `@agents-js/browser-runtime` as the runtime, a Lit `<docs-meta-agent>` element as the UI, and a VitePress Vue wrapper as the embedding surface.

- **Inference:** WebLLM `MLCEngine` in a dedicated Web Worker. Default model `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` on machines with ≥8 GB device memory; `Llama-3.2-1B-Instruct-q4f16_1-MLC` on 4–7 GB; `SmolLM2-360M-Instruct-q4f16_1-MLC` only as a fallback.
- **Action loop:** A small JSON Schema 2020-12 envelope with four kinds (`answer | tool | clarify | error`), validated by Ajv. Decision is constrained JSON; the final answer is streamed text.
- **Tools:** Two read-only tools (`searchDocs`, `readCodeSnippet`) over a build-time-generated static corpus (`docs/public/docs-index.json`).
- **Boundary:** A browser ACP shim presents `initialize`, `session/new`, `session/prompt`, `session/cancel` over JSON-RPC-shaped messages. No subprocess, no HTTP — local method calls.

## Non-decisions (deliberately out of scope for v1)

- Runtime BAML in the browser. Build-time BAML authoring may revisit later.
- Service-worker-backed cross-page model persistence.
- Arbitrary fetch tools or any write tools.
- 7B+ default models.

## Consequences

Visitors with WebGPU pay a one-time ~700 MB download for a fully local agent. Visitors without WebGPU now get a **mocked-endpoints mode** instead of a dead-end fallback message: a `createMockRunner()` factory in `@agents-js/browser-runtime` returns a `PromptRunner` that emits a deterministic tool-invocation + answer-chunk sequence using the same JSON-RPC envelope as the live runner. The seam is one level above the wire (the `PromptRunner` interface), so no protocol-level mocking is needed; HTTP/SSE/WS mocking via MSW is reserved for hypothetical future work that needs to mock the gateway surface. CI does not exercise inference; a manual `bun run docs:dev` + browser run remains required to validate model behavior.

## Update — 2026-04-26

The `decideAction` system prompt was rewritten to include the action schema with worked examples for each `kind`. Empirical observation: small local models (1-3B params) routinely fabricated field names when given only abstract instructions like "return JSON matching the action schema", causing the meta-agent loop to bail with `kind: "error"` and "invalid action JSON". The new prompt embeds the four valid shapes directly. The Lit element's `handleEmit` now also renders `clarify` (as `🔎 <prompt>`) and `cancelled` events that the loop emits but the UI previously silently swallowed.

## v2 update (2026-04-26)

The single `<docs-meta-agent>` element from v1 has been retired in favor of a composed Lit element graph. The page is now a two-pane shell mounted by the same `<DocsMetaAgent />` Vue wrapper as before, but the wrapper now drives `<docs-playground-shell>`, which composes `<docs-chat-pane>`, `<docs-run-controls>`, `<docs-trace-inspector>`, and `<docs-manifest-editor>`.

### Architecture

- **PlaygroundStore reducer.** All cross-component state (transcript, run phase, manifest, replay buffer) lives in a single reducer. Components subscribe; they never mutate each other's state directly. This is the seam tests pin against.
- **RuntimeAdapter abstraction.** The store does not know about WebLLM, the mock runner, or the mode toggle. It dispatches against a `RuntimeAdapter` interface (`start`, `cancel`); the WebLLM-backed and mock-backed adapters implement it. Selecting a runtime in the manifest swaps the adapter — that is the only seam the runtime swap touches.
- **AG-UI event bridge.** The single seam between the meta-agent loop and the UI is an AG-UI event stream. The trace inspector consumes it directly; the chat pane consumes a derived projection; replay re-emits it from a per-run buffer. No alternate paths.

### Decisions

- **YAML preview is render-only — no parser ships.** The structured form is the source of truth; the YAML view is a one-way projection for readability. Closed-by-design: introducing a YAML parser would re-create a second source of truth and reopen the round-trip-equivalence question that v1 deliberately closed.
- **Replay is per-run, not persisted.** The replay buffer lives in store state and is cleared when a new run starts. Persistence (cross-reload, exportable transcripts) is a separate project with its own privacy and storage-quota questions; deliberately out of scope here.
- **Cancel interrupts the model, not just the loop.** The store's `cancel` dispatch wires through to `MLCEngine.interruptGenerate()` via the adapter, not just an AbortController on the loop. Without the engine-level interrupt, a generating model would keep streaming tokens past the UI cancellation.

### Resolved transient: parallel-task filesystem race (formerly mis-diagnosed as "vp-cache")

`mise run ci` and the pre-push hook intermittently reported `[check] ERROR task failed` on a clean local environment despite `bun run check` exiting clean independently. Originally framed as a "vp-cache" transient and worked around with `SKIP_PREPUSH=1`. The actual root cause was a filesystem race in mise's parallel `depends` resolver: `[tasks.ci] depends = ["install", "check", "test:vp"]` ran the three tasks in parallel, and `test:vp`'s per-package `tsdown --clean` rm-rf'd `packages/<pkg>/dist/` while `check`'s `tsgo --noEmit` was reading `dist/index.d.mts` to resolve workspace deps (the `tsconfig.json` chain extends `tsconfig.workspace.json`, not `tsconfig.dev-paths.json`, so deps resolve through built artifacts not source). The race produced an intermittent `TS2307: Cannot find module '@agents-js/<pkg>'` that mise filtered out of its default output.

Fixed in `mise.toml` by serializing `check` before `test:vp` (`depends = ["check"]`, `depends_post = ["test:vp"]`) and dropping the redundant `install` step (the pre-push hook's phase 1 already runs `bun install`). Trade-off: ~3s wall-clock cost for a deterministic gate. The `SKIP_PREPUSH=1` bypass is retired with this commit.

### Carry-over follow-ups

Filed as Plane tickets, not blocking M7-part-1:

- **M4 pre-activation UX gap: clarify when manifest changes take effect** — the editor accepts edits before the first run, but the resulting "applied" timing is implicit. Tighten the affordance.
- **M5 replay test brittleness on real wall-clock 80ms scheduling** — the replay scheduling test uses a real `setTimeout`; flakes against jittery CI. Migrate to a fake clock.
- **M6 streamAnswer cancel test asserts exact 5 chunks observed** — the assertion encodes scheduler ordering rather than the cancel invariant. Reframe around "no chunks observed after cancel".
- ~~**vp-cache transient: investigate SKIP_PREPUSH=1 documented bypass**~~ — *resolved in this same commit; root cause was a parallel-task filesystem race in `mise.toml`'s `[tasks.ci].depends`. See "Resolved transient" above.*
