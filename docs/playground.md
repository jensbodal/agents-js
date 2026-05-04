---
title: Playground — Local Docs Meta-Agent
---

# Playground

Ask the agents-js docs a question. The agent runs **entirely in your browser** using WebGPU and a local language model. No requests are sent to a server. First activation downloads ~700 MB and is cached for subsequent visits.

The page is a two-pane workbench. The left pane is the chat — your prompt, the agent's streamed answer, and a row of run controls (Send, Cancel, Replay). The right pane is a tabbed inspector with two tabs:

- **Trace** — the live AG-UI event stream for the active run, color-coded by event type so tool calls, deltas, and lifecycle events read at a glance.
- **Manifest** — the structured editor that controls runtime selection, permissions, and tool boundaries. It is the source of truth: edit, **Validate & Apply**, and the next run picks up the new config. The mocked-endpoints toggle from earlier builds is gone — pick the runtime in the manifest instead, including a deterministic mock runtime for browsers without WebGPU.

> **Browser requirements (model runtime):** Chrome 113+, Edge 113+, or another browser with WebGPU enabled, on a secure context (HTTPS or `localhost`). Browsers without WebGPU can still use the playground — pick the mock runtime in the manifest.

<DocsMetaAgent />

## What it can do

- Answer questions about ACP, A2A, primitives, surfaces, and protocols using the static docs index.
- Stream tool calls and lifecycle events into the Trace inspector as the run progresses.
- **Cancel mid-stream.** The Cancel button interrupts WebLLM generation within ~300ms; the partial answer stays in the transcript with a `cancelled` lifecycle event in the trace.
- **Replay a completed run.** Hit Replay to re-watch the most recent run as a deterministic 50ms-per-event re-emission. The replayed view is visually distinguishable from a live run so you can tell them apart at a glance.
- Round-trip the manifest: edit it, **Validate & Apply**, and the next run consumes the new selection.

## What it cannot do

- Reach the internet, write files, or run code.
- Replace the official reference docs — when in doubt, follow the sidebar links.
- Persist runs across page loads. Replay is scoped to the run you just watched.
