---
title: Playground Smoke — Manual Verification
---

# Playground smoke — manual verification

The CI smoke (`bun run docs:smoke`) is build-time only. It asserts the page is wired correctly but does not launch a browser. A full real-browser smoke is a deferred follow-up modeled on `scripts/browser-smoke.ts`.

To verify locally:

```bash
bun run docs:index
bun run docs:dev
```

Open the URL VitePress prints, navigate to `/playground`, and confirm:

1. The `<docs-meta-agent>` host renders.
2. On a WebGPU-capable browser (Chrome 113+ on a desktop GPU): an "Activate" button is visible.
3. On a non-WebGPU browser (e.g., Firefox without flags): the unsupported message is visible.
4. Clicking "Activate" downloads the model (visible progress text), then the chat input becomes interactive.

Until the deferred Playwright smoke lands, treat this manual run as the v1 verification of the local model path.
