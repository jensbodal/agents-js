---
title: Browser UX Smoke
---

# Browser UX smoke (LT-8)

`scripts/browser-smoke.ts` is the headline learning test for the browser /
operator UX surface. It drives a **real Chromium browser** against the
reference web UI (`apps/web-ui`) and captures the documented quickstart flow
end-to-end, with screenshots and DOM assertions as durable proof.

Run it:

```bash
bun run browser:smoke
```

This stands up a deterministic A2A gateway backed by the mock ACP agent
(`tests/mock-acp-agent.cjs`), boots the web-ui dev server pointed at that
gateway, and drives an isolated repo-owned Playwright CLI through the flow.

## What it proves

The [Getting Started](/getting-started) quickstart claims:

> a connect dialog → press `Connect` → send `Hello` → reply streams into a
> transcript

This smoke flips that claim from asserted to captured. Its checks
(recorded in `output/playwright/browser-smoke/summary.json`):

- The web UI renders the **connect dialog**, and the dialog honors the
  configured `?target=` gateway override.
- The **Connect** button enables only after target inspection succeeds, then
  connecting renders the chat shell (status bar, transcript, prompt input).
- Sending **`Hello`** round-trips a turn: the transcript renders the user
  message and the agent's reply. A DOM assertion confirms both the prompt and
  the mock agent's reply text are present in the rendered bubbles.
- Elicitation (accept / decline / cancel) and auth-selector overlays resume
  the turn deterministically.
- The debug panel's Session and Trace views render.
- Connect preferences persist to `localStorage` and restore after a reload.

Screenshots are written for the initial connect, the post-turn transcript,
the overlay flows, the debug panel, and the restored-preferences state.

### On "streams"

The mock ACP agent delivers its reply as incremental `agent_message_chunk`
updates over the live ACP/A2A transport — the reply genuinely streams. This
smoke asserts the **rendered result** (the agent bubble contains the reply
text), which is the plain reading of "reply streams into a transcript". It
does not assert per-chunk incremental paints.

## Boundary: mock gateway vs. the literal `bun run dev`

This smoke runs against a **deterministic mock gateway**, with the web-ui dev
server launched directly (`vp run @agents-js/web-ui#dev`) and pointed at it via
`?target=`. That makes the browser UX flow fast and reproducible with no
external runtime.

The literal `bun run dev` launcher path — the exact command in the quickstart,
which spawns a **live coding runtime** plus the A2A gateway plus the web UI —
is covered by the companion learning test `scripts/web-ui-live-e2e.ts`:

```bash
bun run e2e:web:live
```

That companion is **runtime-gated**: it needs a real ACP runtime installed and
available. It captures the same browser flow (default connect dialog, the
canonical Open URL connect, a `Hello` prompt lifecycle, debug panel, save +
reload restore) but through the real launcher discovery contract instead of a
`?target=` override.

## Why it is not in `check`

`bun run browser:smoke` needs a real browser and a live dev server, so it is
intentionally **not** part of the `check` / `test:examples` gate.
`scripts/e2e-deterministic.ts` documents that exclusion: the deterministic
gate relies on happy-dom component coverage, and this browser smoke is retained
as a `bun run browser:smoke` local / CI-gated step. Run it directly to verify
the browser UX surface.
