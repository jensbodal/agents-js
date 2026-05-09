---
title: Playground Smoke
---

# Playground smoke

The CI smoke (`bun run docs:smoke`) is build-time only. It asserts the page is wired correctly but does not launch a browser. Browser coverage lives in `scripts/browser-smoke.ts` and the browser smoke package scripts.

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

Treat this manual run as the verification path for the local model page.
