# @agents-js/cli

> The `agents-js` executable: serve, bridge, and proxy ACP runtimes; talk to A2A agents; expose registered agents as MCP tools.

`agents-js` is a CLI for running and interacting with ACP-compatible coding agents (claude, codex, opencode, ...) over the A2A protocol. It bundles seven subcommands covering the full lifecycle: spinning up a gateway, proxying stdio, sending one-shot prompts, exposing agents as MCP tools, and managing the shared agent registry.

## Install

**Bun is required.** The CLI's TUI depends on `@opentui/core`, which ships non-JS assets (`.scm` Tree-sitter grammars) that only Bun's loader can resolve. Running the published `dist/bin.mjs` under plain Node fails with `ERR_UNKNOWN_FILE_EXTENSION`. Install Bun first: <https://bun.com/docs/installation>.

```sh
# Run on demand without a global install
bunx @agents-js/cli --help

# Install globally with Bun
bun add -g @agents-js/cli
agents-js --help

# Or add as a workspace dependency
bun add @agents-js/cli
```

`npm`/`pnpm`/`yarn` install will download the package, but invoking the `agents-js` bin requires Bun on `PATH`. Use `bunx`/`bun add -g` for the cleanest path. Standalone single-binary artifacts (no Bun required at runtime) can be built locally with `bun run build:standalone`; they are not included in the npm tarball.

## Quick start

```sh
# Start a gateway exposing the claude harness over A2A
agents-js serve --harness claude

# In another shell, send a one-shot prompt to it
agents-js send --url http://127.0.0.1:<port> "summarize the README"

# Or open the interactive TUI
agents-js client --url http://127.0.0.1:<port>
```

## Commands

### `agents-js serve`

Expose a configured ACP runtime over A2A as a long-lived gateway. Reads/writes user and project config, supports curated harnesses or custom ACP commands, and falls back to an interactive wizard when required inputs are missing on a TTY.

| Flag | Takes | Default | Effect |
| --- | --- | --- | --- |
| `--harness <id\|custom>` | value | from config | Select a curated harness (claude, codex, opencode, ...) or `custom`. |
| `--acp-command <command>` | value | — | Custom ACP binary to spawn. Mutually exclusive with curated harnesses; requires `--harness custom` when paired. |
| `--acp-args-json <json>` | value | — | JSON array of args passed to the custom ACP command. Only valid with `--acp-command`. |
| `--profile <name>` | value | — | Named profile under a curated runtime; not supported with `--harness custom`. |
| `--host <host>` | value | `127.0.0.1` | Bind host for the A2A server. |
| `--port <port>` | value | `0` (auto) | Bind port; `0` requests an ephemeral port. |
| `--runtime-log-level <level>` | value | runtime default | `debug \| info \| warn \| error \| silent`. |
| `--opencode-disable-external-plugins` | flag | off | Append `--pure` when launching `opencode`. |
| `--default-model <id>` | value | — | Sets `AJS_DEFAULT_MODEL` for the runtime. |
| `--help`, `-h` | flag | — | Print usage. |

**Config:**
- User defaults: `~/.config/agents-js/config.json`
- Project override: `.agents-js/config.json`
- Example template: `.agents-js/config.example.json`

**Examples:**

```sh
agents-js serve --harness claude --port 7878
agents-js serve --harness codex --profile work
agents-js serve --harness custom --acp-command ./bin/my-acp \
  --acp-args-json '["--mode","release"]'
```

**stdout/stderr:** diagnostics (bind address, agent-card URL, mention-middleware status) go to stdout. The serve loop runs until the process is terminated.

---

### `agents-js bridge`

Spawn an ephemeral A2A gateway for a single curated harness. No registry reads, no config writes; shuts down cleanly on `SIGINT` / `SIGTERM`. Use this for one-shot bridging where `serve`'s persistence is undesirable.

| Flag | Takes | Default | Effect |
| --- | --- | --- | --- |
| `--harness <id>` | value | **required** | Curated harness id (claude, codex, opencode, ...). |
| `--host <host>` | value | `127.0.0.1` | Bind host. |
| `--port <port>` | value | `0` (auto) | Bind port. |
| `--runtime-log-level <level>` | value | runtime default | `debug \| info \| warn \| error \| silent`. |
| `--opencode-disable-external-plugins` | flag | off | Append `--pure` when launching `opencode`. |
| `--default-model <id>` | value | — | Sets `AJS_DEFAULT_MODEL` for the runtime. |
| `--help`, `-h` | flag | — | Print usage. |

**Examples:**

```sh
agents-js bridge --harness claude
agents-js bridge --harness codex --port 9000 --runtime-log-level debug
```

**stdout/stderr:** the bind address line goes to stdout. Exits with code 0 on `SIGINT` / `SIGTERM`, code 1 on argument or runtime resolution errors.

---

### `agents-js acp`

Proxy stdio between this process and a configured ACP runtime. Pipes raw bytes between parent stdin/stdout and the spawned child. **Never prompts interactively.** Defaults to the `claude` harness when no flag or config is provided.

| Flag | Takes | Default | Effect |
| --- | --- | --- | --- |
| `--harness <id\|custom>` | value | from config or `claude` | Select a curated harness or `custom`. |
| `--acp-command <command>` | value | — | Custom ACP command. |
| `--acp-args-json <json>` | value | — | JSON array of custom ACP args. |
| `--directory <path>` | value | — | Constrain runtime to a workspace directory. |
| `--profile <name>` | value | — | Named profile for curated runtimes. |
| `--runtime-log-level <level>` | value | runtime default | `debug \| info \| warn \| error \| silent`. |
| `--opencode-disable-external-plugins` | flag | off | Append `--pure` when launching `opencode`. |
| `--default-model <id>` | value | — | Sets `AJS_DEFAULT_MODEL`. |
| `--help`, `-h` | flag | — | Print usage. |

**Examples:**

```sh
agents-js acp --harness claude
agents-js acp --harness codex --directory ./project
```

**stdout/stderr:** stdout is reserved for ACP protocol bytes; all diagnostics go to stderr. The first stdout chunk from the runtime is validated as ndJSON with a `jsonrpc` field; on contamination the command fails fast (`EXIT_PROTOCOL_CONTAMINATION` = 70) instead of hanging.

**Exit codes:** see the [Exit codes](#exit-codes) section — `acp` uses `EXIT_OK`, `EXIT_ERROR`, and `EXIT_PROTOCOL_CONTAMINATION`.

---

### `agents-js mcp`

Start an MCP server (stdio transport) that exposes registered A2A agents as MCP tools, or generate MCP client config for Claude Code.

| Flag | Takes | Default | Effect |
| --- | --- | --- | --- |
| `setup` | positional subcommand | — | Switch from "start server" to "write config". |
| `--claude` | flag | off | (with `setup`) Register via `claude mcp add` instead of writing a file. |
| `--global` | flag | off | (with `setup`) Write to `~/.claude/settings.json` instead of `.mcp.json`. |
| `--help`, `-h` | flag | — | Print usage. |

**Config resolution (server mode):**
1. `AGENTS_JS_BRIDGE_CONFIG` env var (path to JSON file)
2. `AGENTS_JS_BRIDGE_AGENTS` env var (inline JSON array)
3. Shared agent registry (`~/.agents-js/registry.json`)

**Examples:**

```sh
agents-js mcp                      # start MCP stdio server
agents-js mcp setup                # write .mcp.json in cwd
agents-js mcp setup --global       # write ~/.claude/settings.json
agents-js mcp setup --claude       # register with `claude mcp add`
```

**stdout/stderr:** the MCP protocol uses stdio; diagnostics (no-agents warnings, setup confirmations) go to stderr.

---

### `agents-js client`

Open the A2A client TUI against a running gateway, send a one-shot message, or probe endpoints without the TUI.

| Flag | Takes | Default | Effect |
| --- | --- | --- | --- |
| `--url <base-url>` | value | — | Connect using a base A2A URL. Mutually exclusive with `--card`. |
| `--card <card-url>` | value | — | Connect using a full agent-card URL. Mutually exclusive with `--url`. |
| `--header <name:value>` | value | — | Repeatable custom request header. |
| `--context-id <id>` | value | — | Reuse an existing context id. |
| `--task-id <id>` | value | — | Reuse a specific task id. |
| `--raw` | flag | off | Show raw JSON in the inspector / probe output. |
| `--message`, `-m <text>` | value | — | Send a single message and print the response (no TUI). |
| `--probe` | flag | off | Probe endpoints, print results, exit. |
| `--no-poll` | flag | polling on | Send messages without polling task state to completion. |
| `--help`, `-h` | flag | — | Print usage. |

**Examples:**

```sh
agents-js client --url http://127.0.0.1:7878
agents-js client --card http://127.0.0.1:7878/.well-known/agent-card.json
agents-js client --url http://127.0.0.1:7878 -m "hello"
agents-js client --url http://127.0.0.1:7878 --probe --raw
```

**stdout/stderr:** TUI renders to stdout; probe output and `--message` responses go to stdout. The TUI requires a TTY — when stdout is not a terminal, the command refuses to start and writes a hint to stderr.

---

### `agents-js send`

Non-interactive sibling of `client`: one-shot prompt to a running `agents-js serve`, response to stdout, exits. Does not load the TUI module.

| Flag | Takes | Default | Effect |
| --- | --- | --- | --- |
| `--url <base-url>` | value | `$AGENTS_JS_SERVE_URL` | Target serve base URL. Overrides `--harness` routing. |
| `--harness <id>` | value | — | Route to the first registered agent whose harness id matches. Also threaded as `metadata.harness` on the outbound message. |
| `--raw` | flag | off | Stream `message.delta` chunks to stdout as they arrive. |
| `--help`, `-h` | flag | — | Print usage. |
| `<message>` | positional | **required** | Prompt text; multiple positional tokens are joined with spaces. |

**Examples:**

```sh
agents-js send --url http://127.0.0.1:7878 "explain the build"
AGENTS_JS_SERVE_URL=http://127.0.0.1:7878 agents-js send "what changed?"
agents-js send --url http://127.0.0.1:7878 --raw "stream this"
```

**stdout/stderr:** final agent text (or streamed deltas with `--raw`) goes to stdout; errors and elicitation/auth refusals go to stderr.

**Exit codes:** see the [Exit codes](#exit-codes) section — `send` uses `EXIT_OK`, `EXIT_ERROR`, and `EXIT_AUTH_REQUIRED`.

---

### `agents-js registry`

Manage the shared agent registry at `~/.agents-js/registry.json`. Both A2A and ACP agent kinds are supported.

**Subcommands:**

```text
agents-js registry add <name> <url>                       # A2A (positional URL, default kind)
agents-js registry add <name> --kind a2a --url <url>      # A2A (explicit)
agents-js registry add <name> --kind acp --harness <id>   # ACP
       [--command <cmd>] [--args-json <json>]
       [--env-json <json>] [--workspace-flag <flag>]
agents-js registry remove <name>
agents-js registry list
agents-js registry --help
```

| Flag | Takes | Applies to | Effect |
| --- | --- | --- | --- |
| `--kind <a2a\|acp>` | value | `add` | Agent kind. Defaults to `a2a`. |
| `--url <url>` | value | `add` (a2a) | A2A endpoint URL. Equivalent to the positional form. |
| `--harness <id>` | value | `add` (acp) | Required for ACP entries; gateway runtime id. |
| `--command <cmd>` | value | `add` (acp) | Override the harness's default ACP command. |
| `--args-json <json>` | value | `add` (acp) | JSON array of strings passed as ACP args. |
| `--env-json <json>` | value | `add` (acp) | JSON object of string env vars for the ACP child. |
| `--workspace-flag <flag>` | value | `add` (acp) | Override the harness's default workspace flag (e.g. `--cwd`). |

**Examples:**

```sh
agents-js registry add planner http://192.0.2.5:7878
agents-js registry add reviewer --kind acp --harness claude
agents-js registry list
agents-js registry remove planner
```

**stdout/stderr:** confirmations and listings go to stdout; usage errors go to stderr. Invisible characters in `<name>` are stripped; the normalized name is used and a warning is printed.

---

## Exit codes

Exit codes are exported as named constants from `packages/cli/src/exit-codes.ts` so help text, tests, and runtime exits stay aligned. The values follow `sysexits.h` conventions where they map cleanly.

| Constant | Code | Meaning | Used by |
| --- | --- | --- | --- |
| `EXIT_OK` | `0` | Success | all |
| `EXIT_ERROR` | `1` | Generic failure (transport error, network error, agent-side failure, missing config) | all |
| `EXIT_USAGE` | `64` | Argv mistake — unknown command, missing/conflicting required args | top-level dispatch, `client` |
| `EXIT_DATAERR` | `65` | Malformed payload from a peer | reserved |
| `EXIT_PROTOCOL_CONTAMINATION` | `70` | `acp`: first stdout chunk from the runtime is not valid ndJSON with a `jsonrpc` field | `acp` |
| `EXIT_AUTH_REQUIRED` | `71` | `send`: agent requested elicitation or authentication, which the headless `send` mode cannot satisfy — re-run with `agents-js client` | `send` |

`EXIT_PROTOCOL_CONTAMINATION` is also re-exported from the `acp` module as `ACP_CONTAMINATION_EXIT_CODE` for backwards-compatible embedder access.

## Library API

The `@agents-js/cli` package primarily ships the `agents-js` executable; the `runAgentsJsCli` entry and per-subcommand `parse*` / `run*` helpers plus their dependency-injection interfaces are exposed for embedders who want to invoke a subcommand programmatically (e.g. inside a test harness or a higher-level wrapper). The full type surface is documented in the typedoc output at <https://agents-js.bodal.dev/api/>.

## License

MIT

<!-- This README is hand-maintained. Do not edit via scripts/generate-package-readmes.ts. -->
