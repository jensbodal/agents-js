---
title: Surfaces
---

# Surfaces

> **Status:** Beta · **Validated by:** `apps/web-ui` browser smoke, `apps/internal-gateway` e2e, CLI integration tests · **Known limitations:** Agent Registry is trusted-network-only (no auth, no schema validation, no ACL — see banner in [Agent Registry](#agent-registry)); third-party A2A interop pending; multi-tenant isolation is per-process only

The checked-in surfaces — browser shell, CLI, and multi-agent dispatch — let you run, connect to,
and route between ACP runtimes from your local machine. This page covers the browser surface, the
CLI surface, multi-agent patterns, the agent registry, runnable examples, and the full runtime
matrix.

## Browser

Run a local browser chat surface and talk to your own ACP runtime — claude, codex, opencode, pi,
gemini, or any other supported harness — entirely on your machine. The shell, the gateway, and the
agent all live on localhost.

### Minimum Commands

If you want the fastest path from source to a browser session:

```sh
mise install
bun run setup --runtime claude
bun run dev
```

Use the printed `Open URL`, press `Connect`, and send `Hello`.

### First Steps

The launcher prints:

- `Gateway URL`
- `Gateway WS URL`
- `Web UI URL`
- `Open URL`

Use the printed `Open URL`. It includes the discovered target URLs for that run and is the most
reliable way to land in the correct browser state on first load.

Once the app is open:

1. wait for the connect dialog to finish target inspection
2. press `Connect`
3. send `Hello`
4. send `What is the last message I sent?`

That sequence proves the local browser shell, the gateway connection, and basic session continuity.

### What The Browser App Does

The browser experience in this repo is one connected app:

- `apps/web-ui` renders the browser shell
- `apps/internal-gateway` provides the local A2A bridge to an ACP runtime
- `@agents-js/ui-components` provides the reusable UI building blocks inside that shell

In a normal session you will see:

- a connect dialog before the first connection
- a transcript once connected
- a prompt input for turns
- runtime and session metadata in the shell
- a debug panel for card, session, and trace details
- a conditional `Model` selector when the connected runtime advertises models

When a runtime requests extra interaction, the browser app can also surface:

- an elicitation form
- an authentication selector
- workflow or runtime state notices

### Advanced Browser Workflows

Once the minimum path works, pick the workflow that matches what you need:

#### Integrated browser + gateway

```sh
bun run dev
bun run dev --runtime claude
```

Best for normal product use and local iteration.

#### Browser-only validation

```sh
bun run browser:smoke
```

`bun run browser:smoke` is the canonical mock browser proof and writes artifacts under
`output/playwright/browser-smoke/`.

#### Live browser + real runtime validation

```sh
bun run e2e:web:live -- --runtime claude
```

Best for exercising the browser shell against a real runtime with captured artifacts.

#### Separate gateway and browser

```sh
vp run @agents-js/cli#serve -- --harness claude
vp run @agents-js/web-ui#dev
```

Best when you want to control the gateway lifecycle and the browser lifecycle independently.

### Validation Checklist

Use this section for contributor and operator browser validation. It separates:

- deterministic checks covered by the repo-owned browser e2e lanes
- manual browser checks for stable UI behavior
- runtime-dependent checks that have deterministic fixture coverage in the mock browser proof
- known product gaps discovered while reviewing the current implementation

#### Automated E2E

Use the deterministic mock lane when you want a quick browser validation without depending on a
real local runtime:

```sh
bun run browser:smoke
```

Use the integrated live lane when you want the real runtime + browser proof surface:

```sh
bun run e2e:web:live -- --runtime claude
```

What the automated lanes cover:

| Check | Mock browser proof (`browser:smoke`) | `e2e:web:live` |
|---|---|---|
| Connect dialog renders | yes | yes |
| Default URL matches the launcher-discovered gateway URL | no | yes |
| The printed `Open URL` preloads the discovered `?url=` target | yes | yes |
| Connect button stays disabled until controller-driven target inspection reports the target reachable | yes | yes |
| Connect succeeds against the target gateway | mock-backed | real runtime |
| Connected chat layout appears | yes | yes |
| Prompt input can send `Hello` | yes | yes |
| Prompt input can send `What is the last message I sent?` | no | yes |
| Transcript shows user and agent messages | yes | yes |
| Elicitation accept / decline / cancel flows | yes | no |
| Auth-required selection flow (single deterministic mocked method) | yes | no |
| Status bar lifecycle changes are observed | no | yes |
| Debug panel Card, Session, and Trace views render | partial | yes |
| Model dropdown visibility matches advertised models | no | yes |
| Save + reload restores URL/runtime/model preferences | yes | yes |
| Runtime switching notice behavior is checked when available | no | yes |

Artifacts are written to:

- `output/e2e/web-ui-mock/`
- `output/e2e/web-ui-live/<runtime>/`
- `output/playwright/browser-smoke/`

The live lane treats missing model/runtime metadata as a failure. Skips are only acceptable when
the product genuinely hides the runtime selector or offers only one runtime.

#### Launch Modes

Choose the launch mode that matches what you are validating:

| Mode | Command | When to use |
|---|---|---|
| Mock browser proof | `bun run browser:smoke` | Quick repo-owned validation of the browser shell |
| Integrated live browser e2e | `bun run e2e:web:live -- --runtime claude` | Real runtime + real browser proof without shared browser tooling |
| Real local browser check | `bun run dev` | Manual check against the printed `Open URL` from the integrated launcher |
| Real local browser check (explicit runtime) | `bun run dev --runtime claude` | Manual check against the printed `Open URL` for a specific startup runtime |
| Explicit runtime browser check | `vp run @agents-js/cli#serve -- --harness claude` and `vp run @agents-js/web-ui#dev` | Manual check when you want a specific runtime rather than the checked-in default |

#### Stable Manual Checks

These checks are grounded in the current UI and are suitable for human review.

##### Connect Dialog

| # | Check | Evidence |
|---|---|---|
| C1 | Connect dialog is visible on first load | Screenshot |
| C2 | Default URL matches the launcher-discovered `Gateway URL` | Screenshot |
| C3 | Connect button stays disabled with a readiness message until controller-driven target inspection succeeds | Screenshot or observation |
| C4 | Valid connect transitions into the chat layout | Screenshot |
| C5 | Invalid or unreachable URL keeps Connect disabled and shows a waiting message instead of an immediate red failure | Screenshot |
| C6 | Pressing Enter in the URL input triggers connect | Observation |
| C7 | Opening the printed `Open URL` preloads the discovered `?url=` value into the connect input and overrides stale saved state | Screenshot |
| C7a | Opening the printed `Open URL` preserves the launcher-selected runtime on first load until the user changes it | Screenshot |
| C8 | Local host bridge snapshots can show read-only `Runtime` metadata before connect | Screenshot |
| C9 | Creating, updating, and reloading named profiles preserves URL/runtime/model preferences | Screenshot + reload |
| C10 | Prompt history remains available across reload (up-arrow navigation) | Manual interaction |
| C11 | Selecting a different runtime in the connect dialog applies live without restarting the dev server | Observation |
| C12 | A successful runtime swap that clears queued or in-flight prompts leaves a visible notice explaining that the prompts were cleared | Observation |

##### Status Bar

| # | Check | Evidence |
|---|---|---|
| S1 | Agent name is shown after connect | Screenshot |
| S2 | `connected` status renders as the success state | Screenshot |
| S3 | Session ID is shown and truncates when long | Screenshot |
| S4 | Status can move through active states such as `sending` or `waiting` during a turn | Observation |
| S5 | The selected runtime remains visible in the connected shell when the host bridge provides it | Screenshot |

##### Session Controls

| # | Check | Evidence |
|---|---|---|
| C1 | `Model` dropdown is hidden when the runtime does not advertise models | Screenshot |
| C2 | `Model` dropdown appears after connect when models are available | Screenshot |
| C3 | The current model is selected in the dropdown | Screenshot |
| C4 | Choosing a different model updates the UI after the host snapshot refresh | Observation |

##### Prompt Input

| # | Check | Evidence |
|---|---|---|
| I1 | Prompt input is available after connect | Screenshot |
| I2 | Enter sends a message and clears the textarea | Observation |
| I3 | Shift+Enter inserts a newline without sending | Observation |
| I4 | Clicking Send also sends | Observation |
| I5 | Empty input does not send | Observation |
| I6 | Textarea auto-resizes on multi-line input up to its max height | Observation |

##### Transcript

| # | Check | Evidence |
|---|---|---|
| T1 | Empty state shows `Waiting for messages...` before the first turn | Screenshot |
| T2 | User message renders right-aligned | Screenshot |
| T3 | Agent message renders left-aligned with agent styling | Screenshot |
| T4 | Streaming text can appear while the agent is responding | Screenshot or observation |
| T5 | Transcript auto-scrolls as new content arrives | Observation |
| T6 | If the runtime returns markdown or fenced code, the transcript renders it correctly | Screenshot or pasted reply |

##### Debug Panel

| # | Check | Evidence |
|---|---|---|
| D1 | Debug panel is visible at the bottom of the app | Screenshot |
| D2 | Debug panel is open by default | Screenshot |
| D3 | Card tab shows name, URL, protocol version, and streaming state | Screenshot |
| D4 | Session tab shows status, task state, context ID, task ID, message count, pending text, and elicitation/auth state | Screenshot |
| D5 | Trace tab shows recent debug records when activity exists | Screenshot |
| D6 | Clicking the header collapses and re-expands the panel | Observation |

##### Error Handling

| # | Check | Evidence |
|---|---|---|
| X1 | Invalid or unreachable connect target stays in the connect dialog with Connect disabled until controller-driven inspection succeeds | Screenshot |
| X2 | Controller-level failures after the dialog phase surface in the top-of-page error banner | Observation |
| X3 | A later successful action clears or replaces the prior top-of-page error state as expected | Observation |

#### Runtime-Dependent Checks

These have deterministic fixture-backed coverage in `bun run browser:smoke`. When you are
running a manual check against a real runtime, use the same expectations once that runtime exposes the
state natively.

##### Elicitation Form

| # | Check | Evidence |
|---|---|---|
| E1 | Form appears when the runtime requests elicitation | `browser:smoke` artifact or screenshot |
| E2 | Supported schema field types render correctly | `browser:smoke` artifact or screenshot |
| E3 | Required validation fires on empty accept | `browser:smoke` artifact or screenshot |
| E4 | Accept dispatches an elicitation response | `browser:smoke` observation or manual runtime observation |
| E5 | Decline dispatches a decline response | `browser:smoke` observation or manual runtime observation |
| E6 | Cancel dispatches a cancel response | `browser:smoke` observation or manual runtime observation |

##### Auth Selector

| # | Check | Evidence |
|---|---|---|
| A1 | Modal overlay appears when auth is required | `browser:smoke` artifact or screenshot |
| A2 | The offered auth method choice renders as a clickable action | `browser:smoke` artifact or screenshot |
| A3 | Selecting a method dispatches the auth response | `browser:smoke` observation or manual runtime observation |

Current deterministic coverage exercises one mocked auth method so the checked-in proof surface
validates auth-selection dispatch and overlay behavior. A broader multi-method matrix still belongs
to future runtime or fixture expansion.

#### Known Gaps And Non-Goals

These are not current pass/fail browser checks:

- The first-pass prompt `What is the last message I sent?` is useful as a runtime smoke check, but
  it is not a pure browser-shell assertion.
- Elicitation and auth dismissal depend on follow-up controller/runtime state, so the UI should not
  promise immediate disappearance independent of backend behavior.
- `bun run dev` uses the checked-in internal gateway runtime, which currently resolves to
  `opencode`; `bun run dev --runtime <id>` overrides that startup runtime for the integrated dev
  flow and prints a fresh discovered `Open URL` for that run.
- Runtime switching now has an in-UI path via WS `set_runtime` in the browser reference surface:
  verify unsupported runtimes show a clear fallback notice and successful swaps surface applied
  runtime metadata without restarting the browser.
- If a selected runtime is unavailable, the gateway sends a deterministic unsupported/failed state and
  the UI should stay in a recoverable mode rather than silently failing.

#### Finding Triage

| Category | Definition |
|---|---|
| blocker | Prevents further browser review or invalidates an automated proof lane |
| bug | Incorrect behavior, but testing can continue elsewhere |
| unclear behavior | Unexpected result that may be intended or may be a defect |
| blocked | Check could not be exercised because the required runtime state was unavailable |
| passed | Behavior matched the current expected result |

### Protocol Context

The browser path crosses the repo's main public protocol boundary:

- the browser shell talks to the gateway over **A2A**
- the gateway manages the local agent runtime over **ACP**
- both layers sit on **JSON-RPC 2.0**
- structured input still comes from ACP-carried schema payloads, while **AG-UI** and **A2UI**
  remain alignment references rather than transport claims

See [Protocols & Schemas](/protocols) for the full standards map and the host-owned
extension boundaries.

### Runtime And Model Behavior

- the connect dialog can preload the launcher-discovered gateway target
- runtime metadata can appear before connect when the local host bridge is active
- the `Model` selector only appears when the runtime advertises ACP models
- runtime switching is handled inside the browser shell when the gateway supports it

If the runtime is unavailable or fails startup, the browser shell should stay recoverable instead of
failing silently.

### Troubleshooting

If the browser path is not behaving correctly:

- rerun `bun run check` and `bun run test`
- run `bun run browser:smoke` for the canonical mock browser sanity check
- run `bun run e2e:web:live -- --runtime claude` for a full browser + runtime proof lane
- inspect the debug panel for card and session state

## CLI

Talk to any ACP runtime from your terminal, or expose one over A2A so other tools — browsers,
gateways, MCP bridges, other agents — can reach it. Two flows live here:

- **Connect from a terminal** — drive a running A2A server turn by turn with `agents-js client`.
- **Serve an ACP runtime over A2A** — launch a curated runtime behind the gateway with
  `agents-js serve`, or drop down to a raw stdio proxy with `agents-js acp`.

### Minimum Commands

If you want the shortest terminal-first flow from source:

```sh
mise install
bun run setup --runtime claude
vp run @agents-js/cli#serve -- --harness claude
```

Then, in a second terminal:

```sh
vp run @agents-js/cli#client -- --url http://127.0.0.1:<printed-port>
```

### Recommended First Terminal Flow

1. start a runtime:
   ```sh
   agents-js serve --harness claude
   ```
2. connect with the client:
   ```sh
   agents-js client --url http://127.0.0.1:<printed-port>
   ```
3. send:
   - `Hello`
   - `What is the last message I sent?`

If you are working from the monorepo instead of an installed package, replace `agents-js` with the
`vp run @agents-js/cli#... --` forms shown above.

### Install Paths

#### Published package

```sh
npm install -g @agents-js/cli
agents-js serve --harness claude
```

The published CLI is Bun-backed, so the installed command still expects `bun` on `PATH`.
It includes the Zed-maintained `claude-agent-acp` and `codex-acp` adapter packages as direct
dependencies. Full external CLIs such as `opencode` and `gemini` still need to be installed by the
operator.

#### Monorepo workspace

```sh
vp run @agents-js/cli#serve -- --harness claude
vp run @agents-js/cli#client -- --url http://127.0.0.1:<printed-port>
```

### `serve`

Use `serve` to launch a local ACP runtime through the A2A gateway.

```sh
agents-js serve --harness opencode
agents-js serve --harness claude
agents-js serve --harness gemini
agents-js serve --harness opencode --profile clean-room
```

What `serve` gives you:

- a local A2A base URL
- an agent card URL
- runtime-specific launch handling for curated ACP runtimes

Curated runtime choices:

- `opencode`
- `claude`

See [Runtime Matrix](#runtime-matrix) for runtime resolution details.

#### Profiles

Profiles let you run a curated runtime with a named launch context:

```sh
agents-js serve --harness opencode --profile clean-room
```

Use profiles when you want a cleaner or more isolated runtime environment without changing the base
CLI workflow.

### `client`

Use `client` to connect to an A2A server from the terminal.

```sh
agents-js client --url http://127.0.0.1:<printed-port>
agents-js client --card http://127.0.0.1:<printed-port>/.well-known/agent-card.json
```

Useful options:

- `--header name:value`
- `--context-id <id>`
- `--task-id <id>`
- `--probe`
- `--raw`
- `--no-poll`

The client surfaces:

- target and capability inspection
- a turn-by-turn transcript
- streamed task state
- debug records and raw protocol views

### `acp`

Use `acp` when you need a stdio-to-stdio ACP proxy instead of the higher-level gateway flow.

```sh
agents-js acp --harness claude
agents-js acp --harness opencode --profile clean-room
```

This command is useful for embeddings or tooling that need an ACP-compatible subprocess boundary.

The first stdout chunk from the runtime is validated as ndJSON with a `jsonrpc` field. If the
runtime prints shell banners, plugin warnings, or other non-protocol bytes before the first
JSON-RPC reply, `acp` fails fast with exit code `2` and a diagnostic on stderr — replacing the
prior silent-hang failure mode. The helpers are exported as `inspectFirstChunk` and
`formatContaminationError` from `@agents-js/cli`.

### Protocol Context

The CLI exposes all three of the repo's primary wire layers:

- `serve` exposes an **A2A** gateway over HTTP + SSE
- `client` consumes that **A2A** surface from the terminal
- `acp` keeps the lower-level **ACP** stdio boundary visible when you need it directly
- both ride on **JSON-RPC 2.0**, while runtime manifests and elicitation schemas provide the main
  repo-owned schema surfaces above the transport layer

See [Protocols & Schemas](/protocols) for the standards map and the extension seams.

## Multi-Agent Patterns

Your agent doesn't have to work alone. With `agents-js`, one user's agent can reach out
to another user's agent over A2A, ask it a question, get an answer back, and fold that
answer into the user's own conversation — all without either user leaving their host.

### What Cross-Host Delegation Lets You Do

User A is in Obsidian. They type `@docs-agent what changed in v0.2?`. The `docs-agent`
lives on a different machine, runs a different ACP runtime, and has a different tool
belt — maybe it's `opencode` pointed at a docs repo on User B's laptop. User A's host
catches the mention, dispatches it to User B's gateway over A2A, waits for the answer,
and prepends the result into User A's prompt before the local runtime ever sees it. The
local agent then composes a reply that cites and incorporates the delegated answer.

Neither user has to share machines, sync vaults, or agree on a runtime. Each side owns
its tools and permissions. The only shared state is a list of names and URLs.

### The Two-Host Setup

Two users, two machines, two hosts, one shared registry file per user.

**User A's machine:**

- A host — any of `apps/web-ui`, the `@agents-js/client` terminal harness, the
  `obsidian-acp-plugin`, or a custom embedder built on `@agents-js/acp-host`.
- A local ACP runtime subprocess spawned by that host (`claude`, `codex`, `opencode`,
  `pi`, `droid`, or `gemini`).
- A `~/.agents-js/registry.json` file listing every remote agent they want to reach.

**User B's machine:** exactly the same shape, independently.

**Example `~/.agents-js/registry.json`** (each user edits their own copy):

```json
{
  "agents": {
    "alice-coder": { "url": "http://alice.local:9200" },
    "bob-reviewer": { "url": "http://bob.local:9300" }
  }
}
```

The registry path can be overridden with the `AGENTS_JS_REGISTRY` environment variable.
The resolver lives in `packages/a2a-client/src/node.ts` and re-reads the file off disk
on every mention resolution — there is no in-process cache, so edits take effect on the
next turn without a restart.

### Starting The Two Hosts

The fastest end-to-end demo uses the reference gateway on each machine:

```sh
# On User A's machine
bun apps/internal-gateway/cli.ts --port 9200 --permission-mode yolo

# On User B's machine
bun apps/internal-gateway/cli.ts --port 9300 --permission-mode yolo
```

The reference gateway is the shortest path to a live A2A endpoint, but it is not the
only host. The `obsidian-acp-plugin` is the canonical embedder-style Host A in day-to-day
use, and any host built on `@agents-js/acp-host` can wire the same middleware. For the
embedder path, see [ACP Host Embedding](/harness-guide).

### Two Dispatch Modes: `@mention` vs `@@dispatch`

`agents-js` provides two distinct ways to reach a remote agent. They use the same
registry file but follow completely different code paths:

| | `@mention` | `@@dispatch` |
|---|---|---|
| **Syntax** | `@agent-name` anywhere in the prompt | `@@agent-name` at the start of the prompt |
| **Where it runs** | Any host with `beforePrompt` middleware | Gateway only (`HostA2AExecutor`) |
| **What happens** | Middleware intercepts, dispatches, prepends response, then the local agent sees both | Gateway forwards the entire message to the named agent — no local agent involved |
| **Multiple targets** | Yes — all unique `@name` tokens dispatch in parallel via `Promise.allSettled` | No — one `@@` directive per message |
| **Response framing** | Wrapped in `<a2a-delegation-response>` XML tags and prepended to the user's prompt | Returned directly as the A2A task result |
| **Code entry point** | `createA2AMentionMiddleware()` in `packages/a2a-client/src/middleware.ts` | `HostA2AExecutor.executeDirectDispatch()` in `apps/internal-gateway/host-executor.ts` |

A key implementation detail: when the `@mention` middleware sees a prompt that starts
with `@@`, it returns early without dispatching (see `parseDispatchDirective()` check in
`middleware.ts`). This ensures `@@dispatch` directives are never double-handled — only
the gateway's `HostA2AExecutor` processes them.

### How `@mention` Dispatch Works

Once both hosts are running and each user's registry lists the other agent, here's what
happens when User A types `@bob-reviewer please look at this diff`:

1. **Host A receives the prompt.** User A's host calls `sendPrompt()` on its
   `ACPSessionController` from `@agents-js/acp-host`.

2. **The `beforePrompt` hook fires.** That hook was wired at session-start time to
   `createA2AMentionMiddleware(...)` from `@agents-js/a2a-client`. The canonical
   wiring lives in `obsidian-acp-plugin/src/session-lifecycle.ts`. The controller
   awaits the hook in `packages/acp-host/src/session-controller.ts` before any
   prompt bytes reach the local runtime.

3. **The middleware scans for `@name` tokens** using the regex in
   `packages/a2a-client/src/mention-parser.ts`. It finds `@bob-reviewer`. Email
   addresses like `user@example.com` are skipped because the regex requires the
   `@` to sit at start-of-string or after whitespace.

4. **It resolves the name** through the shared registry — reading
   `~/.agents-js/registry.json` off disk, no caching, on every mention. If the name
   isn't there, the middleware calls `onUnknownAgent` and leaves the mention as
   plain text so the local agent can still try to answer.

5. **It issues a blocking A2A `message/send`** to `http://bob.local:9300` with
   `stream: false, blocking: true` (hardcoded in
   `packages/a2a-client/src/middleware.ts`). Host A's turn pauses until Host
   B responds. If the prompt mentions multiple agents (e.g. `@alice-coder` and
   `@bob-reviewer`), all dispatches run in parallel via `Promise.allSettled`.

6. **Host B's gateway receives the A2A request** and routes it through its own
   `ACPSessionController.sendPrompt()`, which runs User B's local ACP runtime
   (`opencode`, in this example) to compose an answer.

7. **Host B's final text response** is returned over A2A to Host A.

8. **The middleware wraps the response** in an `<a2a-delegation-response>` framing
   block and prepends it to User A's original prompt content. The framing is
   authored in the `defaultBuildResponseBlock()` function in
   `packages/a2a-client/src/middleware.ts` and explicitly instructs User A's local
   agent to treat the delegated answer as authoritative, rather than
   re-investigating what `@bob-reviewer` means. The response block carries
   annotation metadata (`annotations._meta = { source: "a2a-delegation", agentName,
   agentUrl }`) so hosts can programmatically identify delegation content.

9. **User A's local runtime finally sees the prompt** — the framed answer first,
   then User A's original text. It composes its reply using the delegation.

10. **User A reads the final answer** in their host's UI, with the delegated content
    incorporated inline.

### How `@@dispatch` Works

`@@dispatch` is a gateway-only feature. When a user sends a message to a gateway
that starts with `@@agent-name`, the gateway forwards the entire message to the
named agent without involving the local ACP runtime at all.

1. **The gateway receives the A2A request.** The user's message arrives at the
   gateway's `HostA2AExecutor.execute()` method.

2. **The executor parses the `@@` directive** using `parseDispatchDirective()` from
   `packages/a2a-client/src/mention-parser.ts`. The regex requires `@@` at the start
   of the message (with optional leading whitespace): `^\s*@@([a-zA-Z0-9]...)`.

3. **It looks up the agent** in the registry via `loadRegistryFromDisk()`, which
   reads `~/.agents-js/registry.json` synchronously. If the agent name is not found,
   the gateway returns an error listing available agents.

4. **It dispatches the payload** (everything after `@@agent-name`) to the target
   agent's URL via A2A `message/send` with `stream: false`. Unlike `@mention`,
   `@@dispatch` does not set `blocking: true` — the dispatch uses the default
   A2A semantics.

5. **The response is returned directly** as the A2A task result, with metadata
   tagging it as a dispatch (`agents-js.dispatch` in task metadata). There is no
   `<a2a-delegation-response>` framing because there is no local agent to frame
   the answer for.

**When to use `@@dispatch`**: Use it when you want to route a message to a specific
agent deterministically, without your local agent processing or composing around the
answer. It is a direct pipe — the gateway acts as a router, not a mediator.

**When to use `@mention`**: Use it when you want your local agent to incorporate
the remote agent's answer into its own response. The mention flow is richer — the
local agent sees the delegation result and can reason about it.

### What Each User Sees

- **User A** sees their own agent's final reply, which incorporates Bob's answer.
  User A does not see Bob's intermediate thinking — only the final text is fetched,
  because the middleware uses `stream: false`.
- **User B** sees their agent answering what looks like a normal incoming A2A turn
  in their own host's UI. They don't need to know that a human on the other side
  is driving the request indirectly.

### Surfacing Delegation Progress In The Host UI

`createA2AMentionMiddleware()` exposes three lifecycle callbacks so hosts can
render "delegating to @agent" activity in their own workflow or transcript UI
without wrapping the middleware:

- `onDispatchStart({ agentName, promptText, sessionId })` — fires immediately
  before the A2A `sendTurn`, after the target has been resolved and connected.
- `onDispatchSuccess({ agentName, agentUrl, promptText, sessionId, result })`
  — fires after a successful `sendTurn` and before the reply is folded into
  the outgoing response blocks.
- `onDispatchError({ agentName, promptText, sessionId, error })` — fires when
  a started dispatch fails (resolution, network, or `sendTurn` rejection).

`onDispatchSuccess` and `onDispatchError` are mutually exclusive terminals for
the same dispatch. Unknown-agent mentions do not produce an `onDispatchStart`;
they produce `onUnknownAgent` instead. All hooks are awaited, so hosts can
render an activity indicator synchronously before the wire call begins.

```ts
import { createA2AMentionMiddleware } from "@agents-js/a2a-client";

const middleware = createA2AMentionMiddleware({
  agents: { bob: { url: "http://bob.tailnet.ts.net" } },
  onDispatchStart({ agentName }) {
    activityUi.push(`Delegating to @${agentName}…`);
  },
  onDispatchSuccess({ agentName }) {
    activityUi.resolve(`@${agentName} responded`);
  },
  onDispatchError({ agentName, error }) {
    activityUi.fail(`@${agentName} failed: ${String(error)}`);
  },
});
```

### Known Limits

- **Blocking dispatch.** User A's turn pauses while Bob's agent thinks. A slow
  remote agent means a slow local conversation. The ACP host has a 1-hour prompt
  timeout as a backstop. Hosts can surface intermediate "delegating to @agent"
  activity via the `onDispatchStart` / `onDispatchSuccess` / `onDispatchError`
  lifecycle hooks (see above), but Bob's step-by-step reasoning is not streamed
  to User A.
- **Non-streaming.** The `stream: false` flag in the middleware is load-bearing.
  User A does not see Bob's step-by-step reasoning, only the final text. A
  follow-up release may lift this.
- **Per-contextId session lanes, single upstream agent.** `apps/internal-gateway`
  routes concurrent prompts by `contextId` into independent `SessionLane`s.
  Each lane has its own in-flight bookkeeping and can optionally own a dedicated ACP
  controller via the `controllerFactory` hook — distinct contextIds run in
  parallel. One gateway instance still fronts a single upstream agent process,
  so multi-agent or multi-tenant topologies still require separate gateways,
  but concurrent users or tabs under one gateway no longer serialize through a
  global mutex.
- **No registry sync.** `~/.agents-js/registry.json` lives on each user's local
  disk. New agents need to be added on every machine that wants to reach them.
  This is fine for a homelab or a trusted tailnet, but it is not a substitute for
  service discovery.
- **No A2A authentication.** The registry is plain JSON and agent cards are served
  unauthenticated at `/.well-known/agent-card.json`. Assume a trusted network —
  tailnet, VPN, or equivalent — not the public internet.

## Agent Registry

::: danger Trusted-network only
The registry is **plain JSON, unauthenticated, and unsigned**. Agent cards are
served at `/.well-known/agent-card.json` with no auth. Cross-host A2A dispatch
through this registry is appropriate for a homelab, tailnet, VPN, or equivalent
trusted network. **It is not safe to expose to the public internet** — there is
no ACL, no endpoint identity, no schema validation on registry entries, and no
trace redaction guarantee. Public-internet hardening (auth, registry validation,
endpoint identity) is a separate track. See `docs/streaming-and-events.md`
deliberate-limits and the [Known Limits](#known-limits) subsection above.
:::

`agents-js` resolves `@mention` and `@@dispatch` targets through a shared registry file
that lives on the user's filesystem.

### Auto-registration on `serve`

Starting a gateway with `bun run dev` or `agents-js serve` automatically writes the
gateway's name + URL into `~/.agents-js/registry.json` and starts a periodic sync
with any peer URLs already in the file. You don't need to edit the registry by
hand to **be discoverable** — that happens on startup. You only edit the file when
**adding a peer machine** so this gateway can dispatch to it.

Source-of-truth wiring: `packages/cli/src/serve.ts` and
`apps/internal-gateway/index.ts` both call `startRegistrySync()` on startup, which
runs auto-registration once and then a periodic peer pull. Peer pulls hit each known
peer's `GET /.well-known/agents-js-registry.json`, merge in their entries (tagged
`source: "sync"`), and serve this gateway's own version of that endpoint for other
gateways to pull from. Override the sync interval with
`AGENTS_JS_SYNC_INTERVAL_MS=<ms>`.

The static-file editing flow below still works — it's how you bootstrap the first
peer URL into a fresh `registry.json` before the auto-sync chain takes over.

### File Format

The registry is plain JSON with one top-level key, `agents`, mapping short names to
target descriptors:

```json
{
  "agents": {
    "code-reviewer": { "url": "http://localhost:3000" },
    "knowledge-compiler": { "url": "http://192.168.1.100:5000" }
  }
}
```

Each entry is a `{ "url": "<http-endpoint>" }` object. The name is what a user types
after `@` in a prompt. The URL must point at an A2A-compatible HTTP endpoint that
serves an agent card at `<url>/.well-known/agent-card.json`.

### Where The Registry Lives

**Default path:** `~/.agents-js/registry.json` (expanded with `$HOME`).

**Override:** set the `$AGENTS_JS_REGISTRY` environment variable to an absolute path.
Hosts that honor the override (including the obsidian-acp-plugin and the reference
browser app) will read the override path instead of the default. Invalid or
unreadable paths fail open — the host continues running but cannot resolve mentions.

The file does NOT need to exist at host-start time. If it's missing, the registry
returns null on every resolve and the host treats `@mention` tokens as plain text.

### How Hosts Read The Registry

There are two registry implementations, both reading the same file:

- **`createSharedAgentRegistry`** (`packages/a2a-client/src/node.ts`) is the
  factory used by `@mention` middleware. It re-reads the JSON file from disk on
  every `resolve(name)` call and does not cache across calls. This is the path
  most hosts use.
- **`AgentRegistry`** (`packages/a2a-client/src/registry.ts`) is a class-based
  registry that caches the parsed config in memory and caches fetched agent cards
  with a 60-second TTL. Call `refresh()` to force a reload.

The gateway's `@@dispatch` path uses its own `loadRegistryFromDisk()` helper
(`apps/internal-gateway/agent-registry.ts`), which is synchronous and re-reads
on every call.

Practical consequence: you can edit `~/.agents-js/registry.json` in your editor while
a host is running, and the next prompt that uses a new mention will see the update
immediately — no host restart required. Flip side: every mention resolve on the
`createSharedAgentRegistry` path costs one filesystem read, which is cheap in
practice but noteworthy if you have a pathologically busy host.

Agent cards fetched from `<url>/.well-known/agent-card.json` are cached by the
`AgentRegistry` class with a 60-second default TTL (see
`packages/a2a-client/src/registry.ts`). The `createSharedAgentRegistry` factory
does not fetch cards itself — it returns an `AgentTargetInput` (just the URL),
and card fetching happens downstream in the `A2AClientProvider.connect()` step.

### Setting Up For Two Users On The Same Tailnet

Assume two users on a trusted network: Alice on `alice.agent.example`, Bob on
`bob.agent.example`. Each user wants to be able to `@mention` the other user's
agent.

**On Alice's machine:**

```sh
cat > ~/.agents-js/registry.json <<'EOF'
{
  "agents": {
    "bob-reviewer": { "url": "http://bob.agent.example:9300" }
  }
}
EOF
```

**On Bob's machine:**

```sh
cat > ~/.agents-js/registry.json <<'EOF'
{
  "agents": {
    "alice-coder": { "url": "http://alice.agent.example:9200" }
  }
}
EOF
```

**Run a gateway on each side** (see [Multi-Agent Patterns](#multi-agent-patterns)):

```sh
# On alice.agent.example
bun apps/internal-gateway/cli.ts --port 9200 --permission-mode yolo

# On bob.agent.example
bun apps/internal-gateway/cli.ts --port 9300 --permission-mode yolo
```

Now Alice can type `@bob-reviewer please look at this diff` in her host, and the
middleware will dispatch to Bob's gateway. Bob can symmetrically type
`@alice-coder what changed yesterday?`.

### Security Posture

The registry is plain JSON with no signing, no authentication, and no ACL. Every
process on the user's machine that can read `~/.agents-js/` can dispatch to any
listed agent.

Agent cards at `<url>/.well-known/agent-card.json` are served unauthenticated.
Requests to the listed URLs are plain A2A with no mutual TLS or tokens.

**Assume a trusted network.** Homelab, tailnet, VPN, or equivalent. Do not use this
registry to point at public internet agents without an auth layer in front. Do not
add URLs you don't control to a registry on a shared machine.

### Known Limits

- **No sync.** Editing one user's registry does not propagate to any other user's
  registry. This is by design for the single-user-per-machine model. A future
  release may add optional sync via a trusted filesystem location or a lightweight
  discovery protocol.
- **No schema validation today.** Malformed JSON fails open (empty registry). Valid
  JSON with unexpected fields is ignored. Consider running `jq . ~/.agents-js/registry.json`
  if you suspect a typo.
- **No agent liveness probes.** The registry does not know whether listed agents
  are actually reachable. A dispatch to a dead URL fails at request time with an
  error that surfaces in the middleware's `onDispatchError` callback.

## Examples

Follow these recipes to spin up a browser chat, run a terminal client against your own runtime,
and route between registered agents. Each one produces a working session you can talk to.

### Local Browser Workflow

Start the integrated browser path:

```sh
bun run dev --runtime claude
```

Then:

1. open the printed `Open URL`
2. press `Connect`
3. send `Hello`
4. send `What is the last message I sent?`

Use this when you want the quickest visual first run.

### Local CLI Workflow

Start the gateway:

```sh
vp run @agents-js/cli#serve -- --harness claude
```

Connect the terminal client:

```sh
vp run @agents-js/cli#client -- --url http://127.0.0.1:<printed-port>
```

Use this when you want a terminal-only local session.

### Choose A Runtime

Use a curated runtime directly:

```sh
agents-js serve --harness opencode
agents-js serve --harness claude
agents-js serve --harness gemini
```

Use an isolated runtime context with a profile:

```sh
agents-js serve --harness opencode --profile clean-room
```

### Validate A Runtime

Run the targeted runtime lane:

```sh
bun run e2e:runtime -- --runtime claude
```

Run the browser + runtime lane:

```sh
bun run e2e:web:live -- --runtime claude
```

Use these when you want confidence that a runtime works through the reference surfaces, not just a
single manual session.

### Quick Browser Confidence Check

```sh
bun run browser:smoke
```

Use this when you want a fast browser sanity check with screenshots and artifacts.

### Multi-Agent Dispatch

Route messages between agents using host-wired `@mentions` and `@@dispatch` directives.

**1. Set up the agent registry** at `~/.agents-js/registry.json`:

```json
{
  "agents": {
    "code-reviewer": { "url": "http://localhost:3001" },
    "knowledge-compiler": { "url": "http://localhost:3002" }
  }
}
```

**2. Start two gateways** on different ports:

```sh
agents-js serve --harness opencode --port 3001
agents-js serve --harness claude --port 3002
```

**3. Connect a client** to either gateway:

```sh
agents-js client --url http://localhost:3001
```

**4. Use dispatch directives** in the client:

- `@@knowledge-compiler summarize this file` -- deterministic routing: the entire message is
  forwarded to `knowledge-compiler` without the local agent seeing it.
- `@knowledge-compiler what do you think?` -- delegation: the local agent sees the message
  and decides how to involve `knowledge-compiler`.

The `@@` prefix consumes the full message for direct forwarding. The single `@` prefix is an
annotation the host can act on when it installs A2A mention middleware.

### Debugging Connection Or Runtime Issues

If a local run is behaving strangely:

```sh
bun run check
bun run test
bun run browser:smoke
bun run e2e:runtime -- --runtime claude
bun run e2e:web:live -- --runtime claude
```

Common patterns:

- browser issue: start with `bun run browser:smoke`
- runtime issue: start with `bun run e2e:runtime -- --runtime <id>`
- integrated issue: use `bun run e2e:web:live -- --runtime <id>`

## Runtime Matrix

This is the reference for the curated ACP runtimes supported by the checked-in Browser and CLI
surfaces.

### Supported Runtimes

| Runtime    | Status                              | Command            | Ownership                      | Resolution                          | Notes |
| ---------- | ----------------------------------- | ------------------ | ------------------------------ | ----------------------------------- | ----- |
| `claude`   | Default validated path              | `claude-agent-acp` | Zed-maintained package         | CLI/workspace package bin, then `PATH` fallback | Default docs path and primary browser/CLI proof lane. |
| `opencode` | Validated adapter path              | `opencode acp`     | External CLI                   | `PATH`                              | Use the clean-room profile path when local OpenCode plugins make diagnostics noisy. |
| `gemini`   | Adapter present; validate locally   | `gemini --acp`     | External CLI                   | `PATH`                              | Requires the Gemini CLI to expose its ACP mode in the local environment. |
| `codex`    | Adapter present; validate locally   | `codex-acp`        | Zed-maintained package         | CLI/workspace package bin, then `PATH` fallback | Uses the `codex-acp` bridge; API-key auth works for spawned contexts, while local subscription login is not portable to remote-spawned contexts. |
| `pi`       | Adapter present; wire validation pending | `pi-acp`       | In-repo (@agents-js/pi-acp)    | workspace package bin, then `PATH` fallback | Requires the separate `pi` CLI and its local login state; do not treat as broadly validated yet. |
| `droid`    | Adapter present; wire validation pending | `droid-acp`    | In-repo (@agents-js/droid-acp) | workspace package bin, then `PATH` fallback | Requires the separate Droid CLI and `FACTORY_API_KEY` or local Droid auth state; do not treat as broadly validated yet. |
| `trial`    | Deterministic test fixture              | `trial-agent`  | In-repo (@agents-js/trial-agent) | workspace package bin, then `PATH` fallback | Exercises the ACP wire and tool primitives for tests; not a production runtime. |
| custom     | Supported by ACP contract           | operator-provided  | Operator                       | operator-provided                   | Any command is acceptable if it speaks ACP over stdio. |

### Behavior

- the gateway resolves the selected runtime before boot
- the operator CLI exposes the curated runtime selection through `serve`
- the default CI gate runs `bun run e2e:deterministic`
- runtime-specific flows are validated through targeted `bun run e2e:runtime -- --runtime <id>` and `bun run e2e:web:live -- --runtime <id>` runs
- `bun run e2e:runtime -- --runtime opencode --profile clean-room` is the clean-room path when a developer's personal OpenCode config is noisy
- curated runtimes use their normal local environment by default
- explicit isolation or alternate launch context belongs behind `--profile <name>`, not behind hidden default behavior
- runtime-gated CI jobs should be explicit opt-in, not part of the always-on deterministic lane

### Provenance

- `opencode` is not maintained in this repo
- `claude-agent-acp` is not maintained in this repo; the published CLI depends on Zed's package so the default installed `claude` path works without a separate global adapter install
- `codex-acp` is not maintained in this repo; the published CLI depends on Zed's package, and OpenAI endorses Zed's adapter as the ACP integration path (see openai/codex#2785)
- `pi-acp` is maintained in this repo as `@agents-js/pi-acp`; it wraps `@mariozechner/pi-coding-agent` via the native `pi --mode rpc` NDJSON stream
- `droid-acp` is maintained in this repo as `@agents-js/droid-acp`; it wraps Factory.ai's `droid` CLI via per-turn `droid exec --output-format stream-json` invocations
- `trial-agent` is maintained in this repo as `@agents-js/trial-agent`; it is a deterministic fixture runtime for ACP/tooling proof, not an operator runtime
- `gemini` is not maintained in this repo
- the repo wires the runtimes into the gateway and CLI, and the lower-level `apps/internal-gateway` workspace keeps a direct `@agents-js/acp` edge for its local gateway test harness

### Practical Use

```sh
vp run @agents-js/cli#serve -- --harness opencode
vp run @agents-js/cli#serve -- --harness claude
vp run @agents-js/cli#serve -- --harness codex
vp run @agents-js/cli#serve -- --harness pi
vp run @agents-js/cli#serve -- --harness droid
vp run @agents-js/cli#serve -- --harness gemini
vp run @agents-js/cli#serve -- --harness trial
vp run @agents-js/cli#serve -- --harness opencode --profile clean-room
bun run e2e:runtime -- --runtime claude
bun run e2e:web:live -- --runtime claude
```

### Auth

Each harness picks up credentials from the operator's environment; the gateway does not
validate auth at spawn time. If credentials are missing, the harness itself emits an error.

| Runtime    | Env vars forwarded                           | Notes                                                                                        |
| ---------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `opencode` | Operator env (no provider-specific forward)  | Configure via opencode's own config.                                                         |
| `claude`   | `ANTHROPIC_API_KEY`                          | Forwarded to the agent process only (not to terminal tools).                                 |
| `codex`    | `CODEX_API_KEY`, `OPENAI_API_KEY`            | Either works; ChatGPT-subscription `codex login` is local-only.                              |
| `pi`       | Operator env (no provider-specific forward)  | Pi manages auth internally via its `/login` TUI; ~/.pi stores credentials.                   |
| `droid`    | `FACTORY_API_KEY`                            | Also reads droid's local credential cache under `~/.factory` when FACTORY_API_KEY is absent. |
| `gemini`   | Operator env (no provider-specific forward)  | Configure via gemini CLI's own auth.                                                         |

Then connect with:

```sh
vp run @agents-js/cli#client -- --url http://127.0.0.1:<printed-port>
```

Use the URL printed by `serve`. The gateway does not assume a fixed port unless you pass one explicitly.

### Profiles

Profiles are top-level config entries in `.agents-js/config.json` or `~/.config/agents-js/config.json`.

- no profile: use the curated runtime without a named profile; command resolution still follows the runtime-specific rules above
- `--profile <name>`: use a named runtime-bound launch context with derived or overridden roots, env, and args
- missing profiles are auto-created in the project config

For curated `opencode`, profiles are the cleaner deterministic path when personal config or plugins add stdout noise around ACP startup.

Example:

```json
{
  "profiles": {
    "clean-room": {
      "runtime": "opencode"
    }
  }
}
```

### Profile Reference

#### Profile Configuration Schema

Each profile entry lives under the `profiles` key in `.agents-js/config.json` (project) or `~/.config/agents-js/config.json` (user). The profile name is the object key.

```json
{
  "profiles": {
    "<profile-name>": {
      "runtime": "opencode" | "claude" | "codex" | "pi" | "droid" | "gemini",
      "args": ["--flag", "value"],
      "env": {
        "KEY": "value"
      },
      "roots": {
        "home": "/custom/home",
        "config": "/custom/.config",
        "data": "/custom/.local/share",
        "state": "/custom/.local/state",
        "cache": "/custom/.cache"
      }
    }
  }
}
```

| Field     | Type                      | Required | Description                                                              |
| --------- | ------------------------- | -------- | ------------------------------------------------------------------------ |
| `runtime` | `"opencode"`, `"claude"`, `"codex"`, `"pi"`, `"droid"`, or `"gemini"` | Yes      | Which curated runtime this profile targets.                              |
| `args`    | `string[]`                | No       | Extra CLI arguments appended after the runtime's base args.              |
| `env`     | `Record<string, string>`  | No       | Additional environment variables merged into the profile's derived env.  |
| `roots`   | `object`                  | No       | Override individual directory roots instead of using the derived layout. |

#### Profile Directory Structure

When a profile is applied, the gateway derives an isolated directory tree under the profiles root. The profiles root is adjacent to the config file that defines the profile.

```
.agents-js/profiles/
  <runtime>/
    <profile-name>/
      .cache/
      .config/
      .local/
        share/
        state/
```

For example, a profile named `clean-room` targeting `opencode` with a project config at `.agents-js/config.json` produces:

```
.agents-js/profiles/opencode/clean-room/
  .cache/
  .config/
  .local/share/
  .local/state/
```

The `roots` field can override any of these paths individually when the default layout does not suit the runtime.

#### `--profile` Flag Usage

Use `--profile` with either `serve` or the runtime e2e lane:

```sh
# Serve with a named profile
vp run @agents-js/cli#serve -- --harness opencode --profile clean-room

# Run runtime e2e with a profile
bun run e2e:runtime -- --runtime opencode --profile clean-room

# Serve claude with a profile
vp run @agents-js/cli#serve -- --harness claude --profile isolated-claude
```

The `--profile` flag always requires a `--harness` (or explicit `--runtime`) argument. The
profile's `runtime` field must match the selected harness. `e2e:web:live` intentionally launches
through `bun run dev --runtime <id>` and does not accept `--profile`.

#### Default vs Profile Behavior

| Aspect         | No Profile (default)                          | With `--profile`                                      |
| -------------- | --------------------------------------------- | ----------------------------------------------------- |
| Environment    | Inherits the operator's full shell environment | Isolated `HOME`, `XDG_*` vars pointing to profile dir |
| Config files   | Uses the runtime's normal config path          | Reads from the profile's derived config root           |
| Extra args     | None beyond the runtime's base args            | Profile `args` appended after base args                |
| Custom env     | None                                           | Profile `env` merged on top of derived XDG vars        |
| Determinism    | Affected by user plugins, shell config, etc.  | Deterministic — isolated from user-specific state      |
| Stdout purity  | May be contaminated by plugins or shell init  | Clean — no user config means no plugin stdout noise    |

#### Profile Auto-Creation

When the `serve` command receives a `--profile <name>` that does not exist in either the project or user config, the CLI auto-creates the profile entry in the project config (`.agents-js/config.json`). The auto-created profile contains only the required `runtime` field, inheriting all default behavior:

```json
{
  "profiles": {
    "my-new-profile": {
      "runtime": "opencode"
    }
  }
}
```

This lets operators create clean-room profiles on the fly without editing config files first.

#### Full Config Example

A complete `.agents-js/config.json` with multiple profiles targeting different runtimes:

```json
{
  "profiles": {
    "clean-room": {
      "runtime": "opencode"
    },
    "debug-opencode": {
      "runtime": "opencode",
      "args": ["--verbose"],
      "env": {
        "OPENCODE_LOG_LEVEL": "debug"
      }
    },
    "isolated-claude": {
      "runtime": "claude",
      "env": {
        "CLAUDE_LOG_LEVEL": "trace"
      }
    },
    "custom-roots": {
      "runtime": "opencode",
      "roots": {
        "home": "/tmp/acp-sandbox",
        "config": "/tmp/acp-sandbox/.config",
        "data": "/tmp/acp-sandbox/data",
        "state": "/tmp/acp-sandbox/state",
        "cache": "/tmp/acp-sandbox/cache"
      }
    }
  }
}
```
