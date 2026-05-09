# @agents-js/pi-acp

In-repo ACP adapter for [Mario Zechner's Pi coding agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent).

Wraps the native `pi --mode rpc` NDJSON stream as an ACP `AgentSideConnection`
over stdio, so any ACP-speaking client (gateway, IDE, CLI) can drive Pi with
the same protocol it uses for Claude, Codex, Gemini, and OpenCode.

## Binary

The package ships a single `pi-acp` binary built via `bun build --compile`.
The gateway-runtime `pi` harness resolves this binary from `PATH` or the
workspace `node_modules/.bin` tree.

```
pi-acp              # start ACP adapter over stdin/stdout (NDJSON)
pi-acp --help
pi-acp --version
pi-acp --provider zai --model glm-5.1
```

Any non-adapter flags are forwarded to the spawned `pi --mode rpc` process.
This lets runtime profiles select Pi providers, models, tools, and session
behavior without adding adapter-specific flags.

Set `PI_ACP_PI_COMMAND` when the desired Pi CLI is not the first stable `pi`
binary on PATH, for example when a shim manager dispatches by executable name.

## Behavior

One ACP session maps to one `pi --mode rpc` child process. Pi's per-process
session id is kept internal; the adapter assigns a stream-local
`pi-acp-session-<n>` identifier returned to ACP clients.

Implemented ACP methods:

- `initialize` — advertises the adapter name, version, and protocol version.
  The first cut advertises no optional capabilities; session load, fork,
  resume, and close are not yet mapped.
- `session/new` — spawns a new Pi child scoped to the requested `cwd`.
- `session/prompt` — forwards the user's text to Pi as a `prompt` RPC and
  streams Pi events back as ACP `session/update` notifications.
- `session/cancel` — forwards Pi's `abort` RPC and resolves the pending
  prompt with `stopReason: "cancelled"`.
- `authenticate` — returns empty; Pi manages provider credentials internally.

## Streaming translation

| Pi event | ACP output |
| -------- | ---------- |
| `message_update` with `assistantMessageEvent.type === "text_delta"` | `session/update` with `agent_message_chunk` |
| `message_update` with `assistantMessageEvent.type === "thinking_delta"` | `session/update` with `agent_thought_chunk` |
| `tool_execution_start` | `session/update` with `tool_call` (status `in_progress`) |
| `tool_execution_update` | `session/update` with `tool_call_update` |
| `tool_execution_end` | `session/update` with `tool_call_update` (status `completed` or `failed`) |
| `agent_end` | Resolves the pending `prompt` with `stopReason: "end_turn"` |

Pi framing events (`agent_start`, `turn_start`, `message_start`,
`message_end`, `turn_end`) carry no ACP-relevant payload and are dropped.
Compaction and auto-retry events are ignored in the first cut; adding them
is a future hook-point once the ACP side has a natural target notification.

## Auth

Pi stores credentials under `~/.pi` via its own `/login` TUI flow, and also
honors provider-specific environment variables read by the Pi CLI itself.
The adapter does not declare provider-specific `authEnvKeys` at the
gateway-runtime layer. Operators can either log in once with `pi /login` or
run a profile that passes provider/model flags while the relevant provider
environment variable is present.

## Scope of the first cut

Deferred:

- `session/load` (requires Pi's session-file introspection)
- `session/fork`, `session/resume`, `session/close`
- Image content blocks on `session/prompt`
- `session_info_update` for Pi's `compaction_start/end` events
- `fs/*` and `terminal/*` client methods (Pi runs its own bash/write/read
  tools in-process and does not need host-side filesystem/terminal shims)
- `requestPermission` and `session/elicitation` (Pi's permission TUI runs
  in-process when the operator drives Pi directly; ACP-side elicitation
  requires a Pi RPC surface that is not present in the current protocol)

Known quirks:

- Pi does not surface a per-call ACP-style `toolCallId` in every
  `tool_execution_*` variant. The translator accepts the documented
  `toolCallId` field and falls back to `id`, `callId`, and nested
  `toolCall.id` / `toolCall.callId` so minor upstream churn does not
  silently break translation.
- Pi emits detailed `thinking_*` deltas. They are forwarded as
  `agent_thought_chunk` so clients that render thinking get the full stream;
  clients that ignore thought chunks simply drop them.

## Protocol targets

- Pi CLI RPC protocol: validated against `@mariozechner/pi-coding-agent`
  0.71.1.
- ACP SDK: `@agentclientprotocol/sdk` ^0.19.0 (consumed via the monorepo
  catalog alias).
