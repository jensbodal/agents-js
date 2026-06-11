# @agents-js/example-agui-transport-smoke

Smoke example for the native AG-UI streaming transport — the `POST /agent`
SSE surface served by [`@agents-js/host`](../../packages/host).

Demonstrates:

- Standing up the real gateway stack (`ACPSessionController` +
  `HostA2AExecutor` + `UniversalA2AServer`) against the deterministic
  mock ACP agent via `createGatewayTestServer`, with the AG-UI endpoint
  mounted via the server's `additionalFetchFactory` hook.
- A live `POST /agent` over `Accept: text/event-stream`, decoding the
  SSE wire into AG-UI events: `RUN_STARTED` → interior → `RUN_FINISHED`.
- The single-active-run gate: a second concurrent `POST /agent` while a
  run is in flight is rejected with HTTP `409` + a `Busy` body, before a
  second SSE stream opens.

The SSE body is parsed by a small in-package frame reader
(`src/sse-frames.ts`) that reuses the production frame-boundary splitter
(`splitAguiSseFrames` from `@agents-js/a2a-client`) but keeps its own
validation-free decoding, so the smoke exercises the raw wire format
directly without pulling in the client's AG-UI schema check.

## Run

```bash
bun run --cwd examples/agui-transport-smoke smoke
```

## Test

```bash
bun run --cwd examples/agui-transport-smoke test
```

## Layout

```
examples/agui-transport-smoke/
  package.json          # workspace example, private
  tsconfig.json         # extends ../../tsconfig.workspace.json
  src/run-input.ts      # minimal valid RunAgentInput builder
  src/sse-frames.ts     # in-package AG-UI SSE frame reader
  src/smoke.ts          # CLI: stream a run + trip the 409 gate
  tests/smoke.test.ts   # RUN_STARTED…RUN_FINISHED + 409-busy assertions
  README.md             # this file
```
