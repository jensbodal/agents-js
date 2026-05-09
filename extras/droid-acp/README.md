# @agents-js/droid-acp

In-repo ACP adapter for Factory.ai's [Droid CLI](https://docs.factory.ai/cli/getting-started/overview).
The adapter wraps per-turn `droid exec --output-format stream-json` invocations
as an ACP `AgentSideConnection` over stdio, so any ACP-speaking host (gateway,
CLI, browser bridge) can drive droid uniformly alongside the other curated
harnesses (claude, codex, opencode, pi, gemini).

## Binary

The package ships a single compiled binary, `droid-acp`, built from
`src/bin.ts` via `bun build --compile`. On macOS it is re-signed adhoc after
compile (via the shared `scripts/sign-cli-bin.ts` helper); on Linux the
sign step is a no-op.

```bash
bun run --cwd packages/droid-acp build     # produces dist/droid-acp
packages/droid-acp/dist/droid-acp --help
packages/droid-acp/dist/droid-acp --version
packages/droid-acp/dist/droid-acp --model glm-5.1 --auto low
```

Any non-adapter flags are forwarded to each spawned `droid exec` invocation
after the adapter-owned session/cwd flags and before the prompt. This lets
runtime profiles choose Droid models, autonomy, and tool flags without adding
adapter-specific options.

## Usage through the gateway

`droid-acp` is registered in `@agents-js/gateway-runtime`'s curated runtime
registry under the id `"droid"`. The gateway resolves the binary from the
workspace `node_modules/.bin` (or from PATH) and spawns it per ACP session:

```bash
vp run @agents-js/cli#serve -- --harness droid
```

The droid CLI itself must be separately installed on PATH:

```bash
# Install droid via Factory's installer (see https://docs.factory.ai/cli)
curl -fsSL https://factory.ai/cli/install.sh | sh
```

## Auth

Droid authenticates via:

1. `FACTORY_API_KEY` env var (preferred for remote / unattended contexts), or
2. Droid's local credential cache under `~/.factory` (populated by `droid`'s
   interactive login).

The gateway declares `authEnvKeys: ["FACTORY_API_KEY"]` on the droid harness
entry, so `@agents-js/acp-host` automatically forwards that variable from
the gateway process into the spawned `droid-acp` child and blocks it from
being overridden by untrusted `extraEnv` input. No adapter-layer credential
exchange is required.

## Session model

Droid's `exec` subcommand is one-shot non-interactive — there is no native
long-lived stdin-driven multi-turn mode at the version targeted here. The
adapter therefore implements an ACP "session" as a sequence of per-turn
`droid exec` invocations:

1. On `session/new`, the adapter records the ACP session id and the
   requested `cwd`. No droid process is spawned yet.
2. On `session/prompt`, the adapter spawns a fresh `droid exec
   --output-format stream-json --cwd <cwd> [--session-id <prior>] <prompt>`
   child. The child's NDJSON stdout is parsed and each event is translated
   into an ACP `session/update` notification.
3. When droid emits its `completion` event, the adapter resolves the
   prompt promise with `stopReason: "end_turn"`. The child exits naturally
   at that point.
4. On the first turn, droid's `system/init` event carries an internal
   `session_id`; the adapter latches it and threads it back via
   `--session-id` on every subsequent turn in the same ACP session so
   droid re-loads conversation history natively.
5. `session/cancel` sends SIGTERM to the active droid process-group,
   terminating the child and any grandchildren (e.g. the bash commands
   droid's Execute tool spawns). The prompt promise resolves with
   `stopReason: "cancelled"`.

**Session state is adapter-managed, not droid-native.** If the adapter
process dies between turns, the droid session id is lost and conversation
continuity is broken. Persisting droid session ids across adapter restarts
is out of scope for v1.

## Event translation

| Droid stream-json event                       | ACP notification                                                   |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `system/init`                                 | captured for `--session-id` continuity; no ACP notification emitted |
| `message` (role=user)                         | dropped (echo of our own prompt)                                   |
| `message` (role=assistant)                    | `agent_message_chunk` (after stripping inline `<thinking>` blocks) |
| `reasoning` (first occurrence per id)         | `agent_thought_chunk`                                              |
| `reasoning` (duplicate — droid quirk)         | dropped                                                            |
| `tool_call`                                   | `tool_call` (status `in_progress`)                                 |
| `tool_result` (isError=false)                 | `tool_call_update` (status `completed`)                            |
| `tool_result` (isError=true)                  | `tool_call_update` (status `failed`)                               |
| `completion`                                  | resolves prompt with `stopReason: "end_turn"`                      |

Unknown event types are dropped silently for forward compatibility with
future droid CLI releases.

## Deferred ACP capabilities

The v1 adapter deliberately declares an empty `agentCapabilities` object:

- `session/load` — droid has no `--resume-within-exec` surface; a full
  session rehydration would require replaying events from droid's local
  session log, which is out of scope.
- `permissions / requestPermission` — droid manages its own autonomy levels
  (`--auto low|medium|high` and `--skip-permissions-unsafe`). Bridging those
  into ACP's `requestPermission` round-trip is a future integration.
- `fs/*`, `terminal/*` — droid runs its own sandbox for these operations;
  the adapter does not forward them to the ACP host.
- `session/elicitation` — droid's `AskUser` tool is exposed through its own
  stream-json channel but is not currently lifted into ACP elicitation
  semantics.

These are architecturally possible extensions; none block the primary
text-prompt + tool-call round-trip lane that this adapter prioritizes.

## Known limitations

- **Full-message streaming, not token streaming.** Droid emits assistant
  text as one `message` event carrying the final text for a model response
  (not a per-token delta stream). ACP clients see a single
  `agent_message_chunk` per assistant response rather than a smooth stream.
  This matches droid's current output semantics; token-level streaming
  would require a different droid output mode.
- **Multi-turn state dies with the adapter.** If the `droid-acp` process
  is restarted between turns, the captured droid `session_id` is lost and
  the next turn starts a fresh droid conversation.
- **Auto-approval required for tool use.** Droid's default autonomy is
  read-only. Operators who want droid to perform file edits or command
  execution from the gateway context must configure autonomy via operator
  environment (e.g. through an AGENTS-level profile) or by adding an
  explicit `--auto` pass-through to the adapter's extra-args surface in a
  future revision.

## Protocol target

- Droid CLI: 0.103.x (empirically verified against the installed binary).
- ACP SDK: `@agentclientprotocol/sdk` from the monorepo catalog
  (protocol version exported via `PROTOCOL_VERSION`).
