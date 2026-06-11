# @agents-js/example-a2ui-surface-smoke

Learning test for A2UI declarative surfaces — the host/renderer pipeline
exercised against a real DOM, from a `CreateSurface` lifecycle through a
user surface event and back.

Demonstrates:

- Driving the `CreateSurface -> UpdateComponents -> UpdateDataModel`
  lifecycle through [`@agents-js/a2ui-host`](../../packages/a2ui-host)'s
  `A2uiHost.applyMessage`, which validates each message, feeds the internal
  `MessageProcessor`, and re-renders the live `SurfaceGroupModel` via
  [`@agents-js/a2ui-renderer`](../../packages/a2ui-renderer)'s `renderSurface`
  + Lit's `render()` into a mount element.
- Asserting the surface renders as **real DOM nodes** — querySelectable
  `acp-*` custom elements in a [happy-dom](https://github.com/capricorn86/happy-dom)
  global document (installed via the `happydom.ts` test preload), not a
  string-level template snapshot.
- A user interaction (`acp-send` CustomEvent emitted by the rendered
  `acp-prompt-input`) round-tripping back through the renderer's action
  binding -> `A2uiHost.onEvent` -> `A2uiBridge` -> the host's
  `sendSurfaceEvent` sink, arriving with the surface id, the bound action
  name (`submit: "send"`), and the event payload intact.

The render-tree leg reuses the ready-made demo sequences `buildDemoMessages`
and `buildLandingMessages` from `apps/web-ui`, so the test exercises the exact
A2UI payload shapes the live web-ui demo pushes. Those sequences render a
display-only `AcpMessage`, so the event leg authors an `AcpChatApp` +
`AcpPromptInput` surface to drive an interactive round-trip.

Companion coverage:
[`packages/a2ui-renderer/tests/surface-view.test.ts`](../../packages/a2ui-renderer/tests/surface-view.test.ts)
asserts the template structure DOM-free;
[`packages/host/tests/a2ui-surface-e2e.test.ts`](../../packages/host/tests/a2ui-surface-e2e.test.ts)
covers the `surface_event` relay across the gateway wire. This learning test
closes the loop with a real DOM render plus a real dispatched DOM event.

## Test

```bash
bun run --cwd examples/a2ui-surface-smoke test
```

## Layout

```
examples/a2ui-surface-smoke/
  package.json          # workspace example, private
  tsconfig.json         # extends ../../tsconfig.workspace.json, adds DOM libs
  bunfig.toml           # preloads happydom.ts before any test module
  happydom.ts           # registers the happy-dom global DOM
  tests/smoke.test.ts   # the learning test
```
