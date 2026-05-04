# @agents-js/trial-agent

> Real-ACP isolation harness for `@agents-js/tools`. Minimal stdio ACP server that dispatches each `session/prompt` to a `@agents-js/tools` primitive (`fetchContext` / `findTools`) or runs the readiness-gate assertions.

**Private** — not published. Used to validate that the `tools` surface works through an actual ACP wire before exposing it to production agents.

## Purpose

`trial-agent` answers a specific question: *does the `@agents-js/tools` coordinator surface still work when invoked through a real ACP runtime, not just through unit tests?* It's the smallest possible ACP-speaking process that exercises the coordinator end-to-end so regressions in the wire surface are caught before they reach a real host.

## Invocation

```sh
bun packages/trial-agent/bin/trial-agent.ts
```

Or as a binary:

```sh
trial-agent
```

The binary speaks ACP over stdin/stdout. Connect via `@agents-js/acp`'s `ClientSideConnection` and send `session/prompt` requests; the prompt handler in `src/prompt-handler.ts` routes them to a `@agents-js/tools` primitive.

## Readiness gates

`src/readiness-gates.ts` defines the assertions the trial agent runs to declare the `tools` surface "ready" — used as a CI gate before promoting changes to the coordinator.
