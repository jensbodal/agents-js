# @agents-js/browser-runtime

> Browser-native runtime for the docs meta-agent: WebLLM worker, JSON action loop, ACP shim.

**Private** — not published to any registry. Consumed directly from source by `apps/web-ui` (and the docs playground) via the workspace.

## What's inside

- **WebLLM worker** (`webllm-worker.ts`) — runs MLC's WebLLM in a dedicated worker so model inference doesn't block the main thread.
- **Browser ACP shim** (`browser-acp-shim.ts`) — speaks enough of the ACP wire protocol in-browser to drive a tools/chat loop without a server-side runtime.
- **Action loop** (`meta-agent-loop.ts`) — JSON-action driven loop with schema validation (`action-schema.ts`, `action-validator.ts`) and a tool registry.
- **Model picker / cache control** (`model-picker.ts`, `cache-control.ts`) — local-storage backed selection and cache management for downloaded model weights.
- **AG-UI event bridge** (`agui-event-bridge.ts`) — emits `@agents-js/agui-types` events as the loop progresses so the host UI can render transcripts.

## Why private

API surface is in flux while the docs meta-agent and playground experience evolve. Once the wire surface stabilizes — and a non-WebLLM runtime adapter is wired — promotion to a publishable package is plausible.

## No build step

This package has no `dist/` and no build script. Its `exports` resolve directly to `./src/*.ts`. Bun and Vite consume the TypeScript sources directly; downstream consumers should do the same.
