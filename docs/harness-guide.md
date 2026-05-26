---
title: Harness Guide
diataxis: howto
---

# Harness Guide

> **Status:** Beta · **Known limitations:** no canonical runtime designation across runtime IDs (use `runtime` for the package layer and `harness` for CLI selection — see [Runtime vs harness glossary](./primitives.md#runtime-vs-harness)). Multi-harness fleet routing beyond the primary entry is parser-only today (see [Surfaces](./surfaces.md)). For the current runtime support matrix, see the [auto-generated runtime matrix](./_generated/runtime-matrix.md) (canonical source).

This guide covers how to build a harness on agents-js — a host adapter that wraps an ACP-compatible coding agent and exposes it over protocols like A2A.

## What is a Harness?

A harness wraps an ACP-compatible agent runtime and mediates its interaction with the outside world. agents-js recognizes three generations of agent integration:

### Gen-1: CLI-only agents (raw ACP stdio)

The agent runs as a child process. The host speaks ACP over stdio/NDJSON directly using `ACPClientController` from `@agents-js/acp`. No host-managed permissions, no terminal multiplexing, no write gates. The host is a thin transport layer.

This is the right choice when you want maximum control and minimal abstraction — for example, a test harness that spawns an agent, sends prompts, and reads raw events.

### Gen-2: Host-mediated agents (acp-host)

`@agents-js/acp-host` layers host concerns on top of Gen-1:

- **Permissions** — `PermissionEngine` evaluates rules per-session; `PermissionStore` persists remembered decisions.
- **Terminals** — `TerminalManager` spawns and tracks terminal processes for the agent.
- **Write gates** — `HostFileAdapters` mediate file writes through a `requestApproval` callback.
- **Elicitation** — `HostElicitationAdapter` handles form-based agent requests.
- **Streaming** — `ACPSessionController` emits `ACPSessionEvent` objects for real-time UI updates.
- **Session storage** — `HostSessionStorageAdapter` persists state across process restarts.

`ACPSessionController` is the Gen-2 entry point. It composes `ACPClientController` with all host-level adapters.

### Gen-3: Multi-agent orchestrated (gateway)

`@agents-js/a2a` and `@agents-js/a2a-client` add network transport. The gateway (`internal-gateway`) routes between multiple Gen-2 agents over A2A:

- `@@dispatch` — forward the entire message to a named remote agent.
- `@mention` — inline agent reference, resolved by `createA2AMentionMiddleware`.
- `@agents-js/mcp-bridge` — expose A2A agents as MCP tools for Claude Code, Cursor, etc.

agents-js provides Gen-2 and Gen-3 out of the box. Gen-1 is available for consumers that need bare transport access.

## ACP Host Embedding

Use `@agents-js/acp` and `@agents-js/acp-host` when you want to run an ACP runtime inside your own
application instead of using the checked-in Browser or CLI surfaces.

- `@agents-js/acp` owns the low-level ACP client controller and stdio/NDJSON transport.
- `@agents-js/acp-host` owns the higher-level host session orchestration layer: permissions,
  write-gate flows, terminal management, elicitation, and workspace-context normalization.
- `@agents-js/validation` provides optional protocol and policy helpers for hosts that want extra
  validation outside the built-in controller flow.

This page is the technical embedding guide. It describes the supported host contract, the new
workspace-context split, and the process boundaries that consumers are expected to own.

### Protocol and Schema Boundary

`@agents-js/acp-host` sits at a very specific boundary:

- it **implements ACP session orchestration** on top of the lower-level `@agents-js/acp` transport
- it **inherits JSON-RPC envelope rules** from ACP rather than redefining them
- it **passes MCP server configuration through ACP session methods** such as `session/new`, `loadSession`, and related session lifecycle flows
- it **does not turn host concerns into protocol concerns**

That last point matters. Permissions, write gates, terminal policy, workspace-root policy, and
workflow rendering are intentionally host-owned extensions. They live above ACP rather than trying
to become new transport semantics.

For the broader standards map, see [Protocols & Schemas](/protocols).

### Stable Host Surface

The host-facing exports live under `packages/acp/src` (the transport
controller, ACP session types, and process spawn helpers) and
`packages/acp-host/src` (the session controller, host adapters, and
observability primitives). See the API reference at [/api/](/api/) for
typed signatures, or the source directly:

- [`packages/acp/src`](https://github.com/jensbodal/agents-js/tree/main/packages/acp/src)
- [`packages/acp-host/src`](https://github.com/jensbodal/agents-js/tree/main/packages/acp-host/src)

The companion `@agents-js/validation` surface covers ACP, A2A, runtime-manifest, JSON-RPC, and
shared host-policy helpers.

### Lifecycle Contract

`ACPClientController` owns the ACP transport lifecycle. The lifecycle
methods are `initialize`, `newSession`, `loadSession`, `prompt`,
`cancel`, and `dispose` — see the
[`ACPClientController` API reference](/api/) for full signatures.

`ACPSessionController` composes that controller with host-level concerns:

- permission evaluation and remembered-rule lookup
- write-gate approval requests
- terminal session lifecycle
- elicitation mediation
- prompt queueing and turn snapshots
- optional session storage

The controller layers are intentionally narrow:

- upstream owns protocol transport, event forwarding, and normalized host hooks
- the host owns UI, approval UX, local labels, local persistence decisions, and any host-native
  affordances

### Host-Owned Boundaries

Hosts are expected to own:

- editor and active-buffer truth
- final write-review UX
- terminal UX
- permission UX
- local labels or other host-only metadata
- dependency discovery for host-native integrations

The session controller forwards ACP protocol events and normalized render descriptors. It does not
impose a specific UI model or persistence strategy on embedders.

For capability-gated history and metadata behavior:

- inspect `state.agentCapabilities`
- only render `loadSession` or session-list UI when the agent advertises those capabilities
- keep host-local labels separate from agent-owned durable history
- treat `session_info_update` as the authoritative agent-owned metadata channel

### Workspace Context

Workspace context is no longer treated as a single overloaded path internally.

`ACPSessionController.start(...)` supports a split model:

- `workspacePath` — legacy single-path input kept for compatibility
- `workspaceIdentityPath` — stable workspace identity used for permission rules, remembered-rule
  matching, workspace-relative display, and scope-candidate generation
- `sessionCwd` — effective working directory sent through ACP `session/new.cwd`
- `directoryPolicy` — grouped `DirectoryPolicy` wrapper covering the three root sets below
  (hosts that prefer to pass an already-grouped policy object can supply it instead of the
  individual fields)
- `approvedReadRoots` — file-read boundaries
- `approvedWriteRoots` — file-write and auto-approved-write boundaries
- `scratchRoots` — always-writable roots for staging and host-owned scratch artifacts

When the explicit fields are omitted, `workspacePath` preserves the legacy behavior: it becomes the
workspace identity root, the session cwd, the default read/write root, and the base for the
default `.tmp` scratch root.

This split exists so hosts can keep policy anchored to a stable workspace identity while still
launching sessions from a more specific working directory.

### Process Creation Contract

The host-managed process-creation entry points are
`createHostACPProcess` (from `@agents-js/acp-host`) and
`spawnACPAgent` (from `@agents-js/acp`).

When choosing between them:

- use `spawnACPAgent` when the default command, args, and inherited environment are acceptable
- inject `createProcess` into `ACPClientController` or `ACPSessionController` when the host needs
  custom cwd, environment minimization, or stricter process policy

`spawnACPAgent` is intentionally low level:

- it does not set the child process `cwd`
- it does not inject workspace-related CLI flags
- it relies on ACP `session/new.cwd` for protocol-level working-directory propagation

`createHostACPProcess` in `@agents-js/acp-host` adds the host-oriented defense-in-depth layer:

- keeps `ACP_WORKSPACE_ROOT` anchored to the workspace identity root
- sets the spawned process `cwd` to the resolved session cwd
- optionally appends a host-configured workspace flag such as `--directory <sessionCwd>`

If your host needs different spawn-time behavior, provide your own `createProcess`. The low-level
ACP transport is intentionally not responsible for consumer-specific workspace flags or host
environment policy.

### Validation Posture

The canonical proof surface for this contract lives in this repo:

- `apps/web-ui`
- `apps/internal-gateway`
- package-level unit and integration tests
- docs and browser validation lanes

External consumers can corroborate the contract, but they are not the release-defining proof
surface for `agents-js`.

### Minimal Example

```ts
import {
  ACPSessionController,
  createNodeFileAdapters,
  type StartConfig,
} from "@agents-js/acp-host";

const controller = new ACPSessionController();

const startConfig: StartConfig = {
  agentConfig: {
    command: "claude-agent-acp",
  },
  workspaceIdentityPath: "/absolute/workspace",
  sessionCwd: "/absolute/workspace/apps/web-ui",
  approvedReadRoots: ["/absolute/workspace"],
  approvedWriteRoots: ["/absolute/workspace"],
  fileAdapters: createNodeFileAdapters(),
};

await controller.start(startConfig);
const sessionId = await controller.newSession();
await controller.prompt("Summarize the current runtime configuration.");
controller.destroy();
```

If you only need the lower-level transport contract, use `ACPClientController` directly. If you
need the full permission/write-gate/terminal host loop, use `ACPSessionController`.

### Cross-host agent dispatch

Hosts built on `@agents-js/acp-host` can delegate to remote A2A agents via the `beforePrompt` hook.
Wire `createA2AMentionMiddleware` from `@agents-js/a2a-client` into your `SessionHooks` and every
`@name` mention a user types will dispatch to the named remote agent before the local ACP runtime
sees the prompt. The remote agent's final text reply is framed and prepended to the user's turn,
so the local runtime uses it as the authoritative answer.

Minimal wiring:

```ts
import { createA2AMentionMiddleware } from "@agents-js/a2a-client";
import { createSharedAgentRegistry } from "@agents-js/a2a-client/node";
import type { SessionHooks } from "@agents-js/acp-host";
import { ACPSessionController } from "@agents-js/acp-host";

const registry = createSharedAgentRegistry();

const hooks: SessionHooks = {
  beforePrompt: createA2AMentionMiddleware({
    registry,
    onUnknownAgent: ({ agentName }) => {
      console.warn(`unknown agent mention: ${agentName}`);
    },
    onDispatchError: ({ agentName, error }) => {
      console.error(`failed to dispatch to ${agentName}:`, error);
    },
  }),
};

const controller = new ACPSessionController();
await controller.start({
  hooks,
  agentConfig: { command: "claude-agent-acp" },
  workspaceIdentityPath: "/absolute/workspace",
});
```

The `registry` field expects a `{ resolve(name): Promise<AgentTargetInput | null> }` object. Most
hosts use the filesystem-backed `createSharedAgentRegistry` factory from
`@agents-js/a2a-client/node`, which reads `~/.agents-js/registry.json`. See the [Agent registry](/surfaces#agent-registry) reference for the file format.

What the middleware does:

1. Detects `@name` tokens in the user's prompt via the parser in
   `packages/a2a-client/src/mention-parser.ts`.
2. Resolves each unique name through the provided `registry`.
3. Issues a blocking, non-streaming A2A `message/send` to each target (`stream: false,
   blocking: true` — see `packages/a2a-client/src/middleware.ts`).
4. Wraps each response in an `<a2a-delegation-response>` framing block and prepends it to the
   user's original prompt content.

Sharp edges to know:

- **Dispatch is blocking.** If a remote agent hangs, the user's local turn hangs with it until
  the ACP host's prompt timeout backstops it. Consider adding your own `onDispatchError` fallback
  UX.
- **Non-streaming.** Your host's UI will not see the remote agent's intermediate thinking. Only
  the final text is injected.
- **Registry is re-read on every resolve.** No caching. The shared registry does not need a
  restart when you edit `~/.agents-js/registry.json`.
- **`@@dispatch` directives are skipped.** The middleware explicitly returns early when the prompt
  starts with `@@`, leaving those for direct-dispatch hosts such as the gateway's
  `HostA2AExecutor` or native Pi peer mode's `input` hook to handle. See
  [Multi-agent patterns](/surfaces#multi-agent-patterns) for the full
  comparison.

For the end-to-end two-host walkthrough, see [Multi-agent patterns](/surfaces#multi-agent-patterns).

## Building a Custom Host Adapter

When the built-in `createNodeFileAdapters` doesn't fit your host platform (e.g., you're running in a browser, a cloud function, or a non-Node runtime), implement the adapter interfaces yourself.

### Implement HostFileAdapters

`HostFileAdapters` is the minimum required adapter. It has two methods:

```ts
import type { HostFileAdapters } from "@agents-js/acp-host";

const fileAdapters: HostFileAdapters = {
  async readTextFile(params) {
    // params.path is workspace-relative
    // Resolve, enforce read boundaries, return { content: string }
    const content = await yourStorage.read(params.path);
    return { content };
  },

  async writeTextFile(params, requestApproval) {
    // 1. Enforce write boundaries
    // 2. Generate a diff or summary
    // 3. Call requestApproval({ path, diff, absolutePath? }) to gate the write
    const approved = await requestApproval({
      path: params.path,
      diff: generateDiff(existing, params.content),
    });
    if (!approved) throw new Error("Write rejected by user");
    await yourStorage.write(params.path, params.content);
    return {};
  },
};
```

Key points:

- `readTextFile` receives a `ReadTextFileRequest` (`{ path: string }`) and returns `ReadTextFileResponse` (`{ content: string }`).
- `writeTextFile` receives a `WriteTextFileRequest` (`{ path: string; content: string }`) and a `requestApproval` callback. The callback returns `Promise<boolean>` — the host's UI decides approve/reject.
- Paths are workspace-relative. Use `resolveWorkspaceFilePath` from `@agents-js/acp-host` to resolve them against the workspace context.
- The `createNodeFileAdapters` factory also implements atomic CAS writes via a staging directory and exposes a `cleanup()` method. These are optional — your adapter doesn't need them.

### Wire into ACPSessionController

Pass your adapters through `StartConfig`:

```ts
import {
  ACPSessionController,
  type StartConfig,
  type HostFileAdapters,
  type HostElicitationAdapter,
  type HostSessionStorageAdapter,
  type SessionHooks,
} from "@agents-js/acp-host";

const controller = new ACPSessionController();

// Optional: implement HostElicitationAdapter for form-based agent requests
const elicitation: HostElicitationAdapter = {
  async request(params) {
    // Show a form to the user, collect response
    return { action: "submit", values: { key: "value" } };
  },
};

// Optional: implement HostSessionStorageAdapter for persistence
const sessionStorage: HostSessionStorageAdapter = {
  async saveSession(sessionId, state) {
    await db.put(`session:${sessionId}`, JSON.stringify(state));
  },
  async loadSession(sessionId) {
    const raw = await db.get(`session:${sessionId}`);
    return raw ? JSON.parse(raw) : null;
  },
};

// Optional: wire SessionHooks for lifecycle instrumentation
const hooks: SessionHooks = {
  onToolCall(tool, sessionId) {
    console.log(`tool ${tool.name} (${tool.status}) in session ${sessionId}`);
  },
  afterPrompt(params) {
    console.log(`turn completed in ${params.durationMs}ms, stop: ${params.stopReason}`);
  },
};

const config: StartConfig = {
  agentConfig: {
    name: "my-agent",
    command: "my-agent-acp",
    args: [],
    env: {},
    authHints: [],
    workspacePolicy: "workspace-root-only",
  },
  workspacePath: "/path/to/workspace",
  fileAdapters,
  elicitation,
  sessionStorage,
  hooks,
  promptTimeoutMs: 600_000, // 10 minutes
};

await controller.start(config);
```

### Emit structured events

`ACPSessionController` emits `ACPSessionEvent` to all subscribers. Subscribe to build your own debug panel, metrics pipeline, or audit log:

```ts
controller.subscribe((event, state) => {
  switch (event.type) {
    case "status_changed":
      console.log(`status: ${state.status}`);
      break;
    case "tool_call_start":
      console.log(`tool started: ${event.toolCallName}`);
      break;
    case "tool_call_end":
      console.log(`tool ended: ${event.toolCallId}`);
      break;
    case "permission_requested":
      console.log(`permission needed: ${event.request.toolCall?.title}`);
      break;
    case "turn_completed":
      console.log(`turn done: ${event.stopReason}`);
      break;
    case "error":
      console.error(`session error: ${event.message}`);
      break;
  }
});
```

For transport-level errors from `ACPClientController`, subscribe separately through the controller's own error channel. The `ACPSessionController` wraps these into `{ type: "error"; message: string }` events.

The `Logger` system in `@agents-js/acp-host` also emits `LogEntry` objects to the global `logStore` and any configured `LogTransport`. See [Observability](/observability) for the full logging API.

## Package Reference

Each package maps to a specific harness concern:

| Package | Concern | Key Exports |
|---------|---------|-------------|
| `@agents-js/acp` | Agent spawning & transport | `ACPClientController`, `ACPHostAdapters`, `spawnACPAgent`, `ndJsonStream`, `ACPClientState`, `ACPControllerEvent`, `ClientSideConnection`, `ACPWorkspaceRootPolicy`, `PROTOCOL_VERSION` |
| `@agents-js/acp-host` | Session orchestration | `ACPSessionController`, `StartConfig`, `HostFileAdapters`, `HostElicitationAdapter`, `HostSessionStorageAdapter`, `SessionHooks`, `createNodeFileAdapters`, `createHostACPProcess`, `createTerminalHandlers`, `TerminalManager`, `PermissionEngine`, `PermissionStore`, `Logger`, `logStore`, `SpanLogTransport`, `EvalTransport`, `resolveWorkspaceContext`, `DirectoryPolicy` |
| `@agents-js/a2a` | Network transport (server) | A2A HTTP JSON-RPC + SSE streaming endpoint |
| `@agents-js/a2a-client` | Network transport (client) | `A2AClientProvider`, `createA2AMentionMiddleware`, `createSharedAgentRegistry`, mention parser |
| `@agents-js/policy` | Permission mediation | `evaluateWriteGate`, `generateUnifiedDiff`, `generateScopeCandidates`, `extractResourceScope`, `validateTerminalRequest` |
| `@agents-js/validation` | Schema validation | ACP, A2A, runtime manifest, JSON-RPC validators |
| `@agents-js/cli` | Terminal surface | `serve`, `client`, `send`, `bridge`, `acp`, `mcp`, `registry` commands |
| `@agents-js/ui-components` | Browser surface | Lit web components: chat, transcript, elicitation forms, permission modals, theming |
| `@agents-js/mcp-bridge` | MCP integration | MCP server that exposes A2A agents as MCP tools |
| `@agents-js/acp-host/editor` | Editor integration | Mention parser (`parseMentions`), frontmatter extraction, inline context builder |
| `@agents-js/gateway-runtime` | Shared runtime catalog | Runtime manifest resolution, profile isolation, environment helpers, install hints |
| `@agents-js/acp-host/editor` | Editor integration | Mention parser (`parseMentions`), frontmatter extraction, inline context builder |
| `@agents-js/schema-utils` | Schema parsing | ACP elicitation form property parsing |
| `@agents-js/a2ui-host/acp-host` | A2UI surface adapter | `HostSurfaceAdapter` + `SurfaceSession` wiring for acp-host tool-call meta path |
| `@agents-js/agui-types` | AG-UI types | Re-exports `@ag-ui/core` (pinned pre-1.0) plus adapter helpers |
| `@agents-js/a2ui-types` | A2UI types | Protocol surface, basic catalog, ACP custom catalog wrapper |
| `@agents-js/canvas-model` | Canvas data model | `createA2uiCanvasNode`, `exportOcif`, `exportJsonCanvas`, inert JSON helpers |
| `@agents-js/a2ui-host` | A2UI DOM host | `MessageProcessor` per mount, hot-reload-safe attach/detach |
| `@agents-js/a2ui-renderer` | A2UI renderer | Maps A2UI component trees onto `acp-*` Lit primitives |
| `@agents-js/reporting` | Code review reporting | Markdown and JSON Canvas output |
| `@agents-js/pi-extension` | Pi CLI extension | Registers A2A agents as Pi tools and can expose the native Pi TUI as an A2A peer |
