# `AgentConfig.workspaceFlag` default rationale

`AgentConfig.workspaceFlag` (see `packages/acp-host/src/types/agent-config.ts`)
defaults to `--directory` when unset. This note explains why the default lives
on the per-agent config rather than a global host-level policy, and why the
value is `--directory` specifically.

## Why default here instead of at host policy

The workspace flag is a property of the downstream agent binary's CLI surface,
not of the host. Different agents spell the same concept differently:

| Agent runtime          | Flag           |
|------------------------|----------------|
| `claude-agent-acp`     | `--directory`  |
| `opencode`             | `--cwd`        |
| `gemini --acp`         | (no flag; cwd) |

A single host-level default cannot be correct for all three. Lifting the
default to a host-policy setting would just force every host to set three
different values, and would still need a per-agent override for the common
case. Keeping the default on `AgentConfig` (with an override path through
`GatewayRuntimeDefinition.acp.workspaceFlag` in
`packages/gateway-runtime/src/runtimes.ts`) is the simpler contract.

## Why `--directory` is the right default

Two reasons:

1. `claude-agent-acp` is the canonical ACP reference implementation. Any
   third-party agent that models itself on claude-agent-acp inherits
   `--directory` by convention.
2. Known deviations are already named explicitly in the curated runtime
   profiles (`opencode` uses `--cwd`; `gemini --acp` omits the flag and
   relies on spawn `cwd`). Unknown third-party agents are therefore
   overwhelmingly likely to match claude-agent-acp's convention. Getting the
   default wrong for them is louder (spawn fails fast with an unknown-flag
   error) than silently omitting the flag.

## What to change if a new runtime emerges

Add the deviating flag to that runtime's `GatewayRuntimeDefinition` in
`packages/gateway-runtime/src/runtimes.ts`. Leave the per-AgentConfig
default alone unless the majority convention itself shifts upstream.

## Related

- `HostACPProcessOptions.workspaceFlag` mirrors this field at the
  spawn-helper layer. See
  `packages/acp-host/src/process.ts:hasWorkspaceFlag` and the contract
  distinction called out on `HostACPProcessOptions` in `docs/api/`.
- `spawnACPAgent` (low-level) and `createHostACPProcess` (host adapter)
  diverge on whether the default is applied at the helper layer vs the
  session controller. See the plugin's 2026-04-16 handoff for the scope of
  that confusion; that pointer is preserved to reduce future spelunking.
