# opencode ZWSP default-agent tracking

Upstream defect we mitigate locally; no fork, no patch. Keep this note until
the upstream fix lands so the mitigation stays defensible.

## Symptom

`opencode` ACP `session/new` fails with:

```
default agent "Sisyphus - Ultraworker" not found
```

when `oh-my-openagent` (>= v3.16.0) is installed in the user's environment.
That plugin injects a zero-width-space (U+200B) as a sort-prefix on agent
display names. opencode's ACP default-agent resolver then looks up the name
literally and the lookup misses.

## Upstream ownership

Two plausible upstream fix sites:

1. `oh-my-openagent` stops injecting invisible code points into the sort
   prefix (or uses an explicit, visible delimiter).
2. `opencode` normalizes whitespace / invisible characters before matching
   agent names in its ACP default-agent lookup.

Either lands upstream and our mitigations become dead weight.

## Local mitigations

Do not remove until at least one upstream fix is confirmed.

1. **Ingress normalization** — `ACPSessionController.start()` passes
   `initResponse.agentInfo.name` through `normalizeAgentName()` before it
   reaches host state. Strips ZWSP, ZWJ, BOM, bidi controls. See
   `packages/acp-host/src/agent-name-normalize.ts` and
   `packages/acp-host/src/session-controller.ts`.
2. **Opt-in `--pure` fallback** — `packages/gateway-runtime/src/runtimes.ts`
   defaults the opencode profile to plugins-loaded. Setting
   `AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS=1` appends `--pure` to the spawn
   args, neutralizing the broken plugin wholesale when the normalization
   defense is insufficient.

## Related backlog

Expansion of `normalizeAgentName()` to additional ACP ingress points
(session updates, tool calls, registry reads) is tracked separately; see
`expand-name-normalization-to-additional-acp-ingress-points` in
`backlog.json`.

## Retirement condition

Remove this note and the two mitigations when either upstream fix is
shipped and verified in a user environment that has
`oh-my-openagent >= 3.16.0` installed.
