# @agents-js/example-acp-runtime-smoke

Smoke example for the **ACP runtime contract** — the full ACP
request-response cycle driven through the public
[`@agents-js/acp-host`](../../packages/acp-host) `ACPSessionController`
surface against a real mock ACP subprocess.

Demonstrates:

- Spawning the real `tests/mock-acp-agent.cjs` JSON-RPC subprocess (no
  stubbed transport) via `ACPSessionController.start()`, which completes
  the ACP `initialize` handshake.
- Opening a session (`newSession`) and driving a turn (`sendPrompt`).
- Observing a **streamed** response: the agent emits multiple
  `agent_message_chunk` updates, asserted as more than one accumulated
  text chunk.
- **Session-state persistence across turns**, proven on two independent
  layers:
  - controller-side: `sessionId` is stable and `completedTurns` grows
    turn over turn;
  - subprocess-side: the mock's `__PROMPT_COUNT__` probe reports the
    accumulated prompt count, proving the same child process — not a
    fresh spawn per prompt — carried state across turns.

## Test

```bash
bun run --cwd examples/acp-runtime-smoke test
```

## Typecheck

```bash
bun run --cwd examples/acp-runtime-smoke typecheck
```

## Layout

```
examples/acp-runtime-smoke/
  package.json          # workspace example, private
  tsconfig.json         # extends ../../tsconfig.workspace.json
  tests/smoke.test.ts   # initialize -> session -> streaming turns -> persistence
  README.md             # this file
```
