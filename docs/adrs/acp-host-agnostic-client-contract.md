---
title: Host-agnostic ACP client interaction contract
created: 2026-03-29
updated: 2026-04-17
status: reference
type: design-note
projects:
  - agents-js
  - obsidian-acp-plugin
tags:
  - acp
  - acp-host
  - architecture
  - design
  - ui
repo_trackers:
  - ../../roadmap.json
  - ../../backlog.json
related_notes:
  - ../acp-host.md
  - host-and-agent-layers.md
---

# Host-agnostic ACP client interaction contract

> **Note (2026-04-17):** This design note was originally authored 2026-03-29 under
> `plans/` and moved to `plans/archive/` on 2026-04-03, then pruned when the plans
> archive was cleared on 2026-04-08 (commit `25790a7`). It is recovered here at a
> durable architecture path so downstream consumers (notably the obsidian-acp-plugin
> backlog) have a stable reference. Direction summary below remains accurate; the
> "host kit" framing is the active position. The obsidian-acp-plugin currently
> imports `ACPSessionController`, `PermissionEngine`, `PermissionStore`,
> `EvalTransport`, `CapabilityCache`, and `Logger` directly from `@agents-js/acp-host`
> (`src/session-lifecycle.ts:1-14`), which is consistent with the "upstream owns
> protocol/runtime" boundary described here — no contract refactor is currently
> blocked by this note.

## Question

What is the reusable host-agnostic ACP client interaction contract, and what remains
adapter-specific?

## Decision summary

The reusable thing is not "the Obsidian plugin with interfaces." The reusable thing is a host kit.

Near-term direction:

1. Keep protocol and lifecycle orchestration upstream in `agents-js`.
2. Define one shared host capability contract above the current controller/session seams.
3. Define one shared interaction and rendering contract that normalizes events and renderable
   concepts without shipping host-specific components.
4. Keep concrete UI, native view lifecycle, and approval UX in each host adapter.

Obsidian remains the first adapter. Notion is the validation case for whether the contract is
actually host-agnostic. AG-UI, A2UI, and ACP elicitation are reference inputs for standards
alignment, not compatibility targets in this pass.

## Implementation update (2026-03-30)

Since this note was written, the release track moved from design-only into active implementation:

- `@agents-js/a2a` now supports `message/stream` and `tasks/resubscribe`.
- `@agents-js/a2a-client` and the CLI now act as the primary reference UX for live task flows.
- ACP form-mode elicitation and auth-required continuation are now implemented in that
  CLI/A2A reference path.

This reinforces the original boundary in this note:

- upstream owns protocol/runtime and semantic interaction contracts
- hosts own concrete renderer implementations

The next renderer-related upstream work should remain schema- and semantics-oriented unless real
cross-host pressure proves that anything more concrete belongs upstream.

## Original design-pass non-goals

For the original design pass that produced this note:

- no implementation changes to `@agents-js/acp` or `@agents-js/acp-host`
- no AG-UI wire compatibility commitment
- no second host implementation
- no attempt to standardize native Obsidian or Notion UI chrome

Those constraints described the scope of the design exercise itself. They do not override the later
implementation update above.

## Current baseline

The current code already gives us a useful split:

- [`docs/harness-guide.md`](/harness-guide) defines the supported downstream host posture.
- [`packages/acp-host/src/types/session.ts`](../packages/acp-host/src/types/session.ts) already
  contains host-agnostic session status, turn state, plan state, queue state, and events.
- [`packages/acp-host/src/types/adapters.ts`](../packages/acp-host/src/types/adapters.ts) and
  [`packages/acp-host/src/types/host-adapters.ts`](../packages/acp-host/src/types/host-adapters.ts)
  already expose generic host seams for file I/O, workspace context, and optional integrations.
- [`../../obsidian-acp-plugin/src/main.ts`](../../obsidian-acp-plugin/src/main.ts),
  [`../../obsidian-acp-plugin/src/ui/session-view.ts`](../../obsidian-acp-plugin/src/ui/session-view.ts),
  and
  [`../../obsidian-acp-plugin/src/registry/plugin-dependency-registry.ts`](../../obsidian-acp-plugin/src/registry/plugin-dependency-registry.ts)
  show the current proof-host embedding.

The missing piece is a named contract for interaction and rendering so the proof host does not
become the architecture by accident.

## Four-layer model

### 1. Protocol core

This layer belongs upstream.

Responsibilities:

- ACP transport lifecycle
- session creation, loading, prompting, cancellation, and disposal
- capability discovery and cached agent metadata
- turn accumulation and normalization
- prompt queue and steer behavior
- permission forwarding and write-gate coordination
- logging, hooks, and observability

Current evidence:

- `ACPClientController` in `@agents-js/acp`
- `ACPSessionController`, `ACPSessionState`, `ACPSessionEvent`, `SessionHooks`, and logger
  infrastructure in `@agents-js/acp-host`

This layer should remain UI-framework-independent and host-platform-independent.

### 2. Host capability contract

This layer belongs upstream as a conceptual contract, with per-host implementations.

Responsibilities:

- identify the host root or working scope
- read and write host resources
- navigate to a host resource
- search host content
- execute host commands or host-native actions
- provide workspace or tenant context
- surface optional integrations
- persist or export artifacts
- collect human approval for host-owned policy decisions

Recommended future concepts:

- `HostCapabilityProvider` or equivalent upstream contract
- resource-oriented operations rather than filesystem-only language
- capability advertisement so hosts can be explicit about what they do and do not support

Why this belongs upstream:

- a second host needs one stable shape to implement
- host-specific code should map local APIs into shared capabilities rather than redefining the
  contract per host

### 3. Interaction and rendering contract

This layer belongs upstream as a semantic contract, but not as a component library.

Responsibilities:

- define canonical interaction events and lifecycle states
- define renderable concepts for text, tool calls, plans, errors, permissions, artifacts, and
  future interrupt/input flows
- preserve ordering and correlation across chunks, tool calls, and artifacts
- expose enough structure that hosts can render consistently without sharing UI code

This is the layer informed by AG-UI, A2UI, and ACP elicitation. It should borrow useful ideas from
those systems without binding the repo to their current drafts.

### 4. Host adapter implementation

This layer belongs per host.

Responsibilities:

- native application lifecycle
- concrete view model and component composition
- native editor or document binding
- notifications, settings, command wiring, and app-specific menus
- host-native permission and write-review UX
- host-native plugin/integration ecosystem
- mapping shared renderable concepts onto local UI primitives

Examples:

- Obsidian: `Plugin`, `ItemView`, `WorkspaceLeaf`, `MarkdownRenderer`, vault APIs, plugin
  registry, modal flows
- Notion: page/database APIs, block rendering, side panels, slash-command surfaces, permission
  rules tied to page ownership and workspace access

## Host-agnostic lifecycle states and events

The current `ACPSessionStatus` and `ACPSessionEvent` union already cover most of the needed shared
state. The next design step should standardize them into a smaller semantic model that any host can
consume.

Recommended canonical event families:

| Family | Canonical semantics | Current evidence |
|---|---|---|
| Lifecycle | session initializing, ready, prompting, cancelling, errored, closed | `ACPSessionStatus`, `status_changed`, `error` |
| Conversation | user prompt submitted, agent text chunks, turn completed | `beforePrompt`, `afterPrompt`, `turn_completed`, text chunks in `TurnState` |
| Tool execution | tool started, updated, completed, failed | `ToolCallInfo`, `onToolCall`, `TurnItem` |
| Plan and metadata | plan replaced, session info changed, queue changed, mode/model changed | `plan_updated`, `session_info_updated`, `queue_changed`, `mode_changed`, `model_changed` |
| Policy and approval | permission requested/resolved, write review requested/resolved | `permission_requested`, `permission_resolved`, `write_gate_requested`, `write_gate_resolved` |
| Artifact and export | artifact proposed, artifact persisted, artifact exported | not yet standardized; currently host-owned and reporting-owned |
| Interrupt and input | agent requests structured human input, user resolves/cancels | future contract; informed by ACP elicitation but distinct from host approval |

### Host-agnostic vs host-owned

Host-agnostic:

- lifecycle state
- ordered text and tool-call activity
- plan/state updates
- artifact proposals and export outcomes
- interrupt/input requests and outcomes

Host-owned:

- where the input field lives
- whether the host uses a sidebar, panel, modal, inline card, or full-page view
- how approvals are collected
- how persisted artifacts appear in the native product

## Rendering contract

The shared rendering contract should standardize data, not components.

### Text

Shared contract:

- ordered user and agent messages
- `messageId` correlation when available
- chunk-to-message association
- completion status and stop reason

Host adapter owns:

- Markdown or rich text rendering
- avatars, spacing, transcript layout, copy actions

### Tool calls

Shared contract:

- tool identity
- lifecycle state
- ordered association with surrounding text
- typed content descriptors such as text, diff, terminal, or structured payload

Host adapter owns:

- diff viewer implementation
- terminal styling
- expandable cards, grouping, and affordances

### Plans

Shared contract:

- ordered plan entries with stable status

Host adapter owns:

- checklist styling, summary placement, collapse behavior

### Errors

Shared contract:

- structured diagnostics with origin, severity, and user-facing message

Host adapter owns:

- banners, toasts, retry affordances, inline error placement

### Permissions and approvals

Shared contract:

- permission request data from ACP
- write-review request data from host policy
- explicit approval outcomes and remembered-rule metadata

Host adapter owns:

- modals, sheets, inline prompts, approval buttons, and any local risk messaging

### Artifacts

Shared contract:

- artifact proposal metadata
- artifact kind and destination hint
- export outcome
- correlation back to session and message ids

Host adapter owns:

- vault path naming, page naming, folder choice, template choice, native export affordances

## Renderer registry decision

The renderer registry should live in the host adapter, not in shared code.

Why:

- hosts have different UI toolkits and native primitives
- shipping shared UI components would couple `agents-js` to a presentation stack it does not own
- Notion and Obsidian cannot realistically share concrete components

What shared code can own later:

- normalized render descriptors
- a small registry contract for mapping a descriptor kind to a host renderer
- common typing for built-in kinds such as `text`, `tool_call`, `plan`, `error`, `permission`,
  and `artifact`

So the boundary is:

- upstream owns render semantics
- each host owns renderer implementation

## External protocol and schema adoption boundary

The decision above should not be read as "ignore AG-UI or A2UI."

What is deferred:

- adopting AG-UI or A2UI as hard compatibility targets before the repo's own semantic layer is
  stable
- shipping shared UI components, host-specific renderers, or a framework-coupled component
  library from `agents-js`

What remains explicitly on the table:

- reusing external protocol or schema vocabulary directly if it cleanly matches the shared semantic
  layer
- importing or mirroring standardized event or render-descriptor schemas in a framework-agnostic
  package
- validating host-produced descriptors against external schemas where that reduces custom design
  burden and improves interop

The practical test is layered:

1. If an external standard helps define host-agnostic **events** or **render descriptors**, it is
   a candidate for upstream adoption.
2. If it requires shared concrete **components**, **framework bindings**, or host-specific UI
   behavior, it belongs in the host adapter instead.

So the active question is not whether the monorepo can contain framework-agnostic UI or UX
capabilities. It can. The real question is which parts belong upstream:

- **yes upstream**: schemas, validation, semantic event contracts, render-descriptor typing,
  adapter utilities
- **no upstream**: Obsidian renderers, Notion renderers, shared component kits, host-native UI
  chrome

This means AG-UI and A2UI should be revisited not as "adopt or ignore" decisions, but as
"which semantic pieces can be used directly without importing the wrong presentation layer?"

### Current audit status

The current code shape suggests a split decision rather than a single "adopt" or "defer" answer.

- AG-UI is the cleaner fit for the semantic event layer.
  - session lifecycle, streamed text, task-state updates, and interrupt/input signals already have
    close analogs in the current `agents-js` runtime
  - this makes AG-UI vocabulary a plausible source for future shared event and descriptor typing
- A2UI is a larger adoption step.
  - it depends on A2A extension negotiation, structured `DataPart` transport, and client-side
    structured payload persistence that the current stack does not yet expose
  - that means it should be treated as a later transport and schema phase, not as an immediate
    renderer decision

So the practical direction remains:

- adopt external schema vocabulary upstream where the semantic fit is clean
- defer concrete structured-UI transport and renderer integration until the A2A extension boundary
  is intentionally designed

## Interrupt handling vs host approval UX

These are related but distinct.

### Interrupt/input contract

This is future upstream surface.

Definition:

- the agent asks the human for structured input, clarification, or a choice needed to continue the
  task

Examples:

- ACP elicitation
- future structured forms or typed confirmations driven by the agent

This belongs in the shared interaction contract because it is part of the agent-host conversation.

### Host approval UX

This remains host-owned.

Definition:

- the host pauses execution to enforce local policy before letting the agent continue or before
  applying a local side effect

Examples:

- permission modal
- write-review modal
- remembered-rule management

This does not belong to agent-authored UI. It is a local trust boundary.

Decision:

- upstream should eventually define an interrupt/input contract
- upstream should not absorb host-native approval UX into agent-driven UI abstractions

## Minimum host capabilities for a second host

A second host should be able to plug into the same harness if it can provide at least:

1. a stable host root or working scope
2. resource read support
3. resource write support with host-controlled review or rejection
4. prompt input and transcript display
5. human permission handling for ACP permission requests
6. workspace or tenant context summary
7. navigation to referenced resources

Optional but desirable:

- search
- host command execution
- integration registry
- artifact sink or export surface
- structured interrupt/input UI

## Host capability matrix

| Shared capability | Obsidian proof host | Notion validation case | Belongs upstream or host |
|---|---|---|---|
| Host root or scope | vault/workspace root path | workspace plus page/database scope | upstream contract, host implementation |
| Resource read | note/file reads via vault APIs | page/block reads via Notion API | upstream contract, host implementation |
| Resource write with review | write-gate plus vault writes | page/block mutation with host-side confirmation | upstream contract, host implementation |
| Navigation | open note in editor at location | open page/database view | upstream contract, host implementation |
| Search | vault search and optional Omnisearch | search pages/databases/blocks | upstream contract, host implementation |
| Host commands/actions | command palette commands | slash commands or scripted workspace actions | upstream contract, host implementation |
| Workspace context | open files and vault summary | recent pages, current page, workspace summary | upstream contract, host implementation |
| Optional integrations | plugin registry | connected integrations or workspace apps | upstream contract, host implementation |
| Artifact sink | markdown note or JSON Canvas export | page, subpage, database row, or export block | upstream contract, host implementation |
| Approval UX | permission modal and write-review modal | inline or modal approval patterns | host-owned |
| Concrete rendering | ItemView plus DOM/MarkdownRenderer | Notion block renderer and panel UI | host-owned |

## Walkthroughs

### 1. Normal multi-turn text conversation

1. Protocol core initializes the ACP session and emits lifecycle state.
2. Host adapter submits prompt text and any host context attachments.
3. Shared interaction contract emits ordered agent text chunks and turn completion.
4. Host adapter renders those messages using its native transcript UI.
5. Shared state retains message correlation and session metadata.

Nothing in this flow should depend on Obsidian-specific components.

### 2. Tool-call-heavy turn with structured rendering

1. Protocol core receives tool call start/update/end events and text chunks.
2. Shared interaction contract normalizes these into ordered text and tool-call render
   descriptors.
3. Host adapter maps descriptor kinds onto local renderers such as diff, terminal, search results,
   or generic structured content cards.
4. Host adapter may group or collapse tools, but it does not reinterpret tool semantics.

This is where AG-UI and A2UI are useful as design references for event taxonomy and component
catalog patterns.

### 3. Permission or write-review interruption

1. Protocol core emits either an ACP permission request or a host-local write-review request.
2. Shared interaction contract records the interruption and pauses the turn at the semantic level.
3. Host adapter presents native approval UX.
4. Host adapter returns an approval outcome to the protocol core.
5. Protocol core resumes or rejects the turn.

Important boundary:

- the interruption state is shared
- the approval UI remains host-native

### 4. Artifact export flow

1. Agent turn completes with enough structured output to justify artifact creation.
2. Shared interaction contract exposes an artifact proposal with session metadata, message
   correlation, artifact kind, and destination hint.
3. Host adapter chooses naming, location, and native persistence format.
4. Host adapter writes the artifact through a host-native sink and emits export outcome back into
   shared observability.

This keeps reporting and export host-aware without forcing artifact layout decisions upstream.

## Future shared surface recommendations

| Concept | Recommendation | Ownership |
|---|---|---|
| Host capability provider | Introduce after the design note is accepted | upstream contract, host implementation |
| Interaction event model | Introduce as the semantic layer above raw session events | upstream |
| Renderer contract | Introduce as normalized render descriptors and registry typing | upstream |
| Renderer registry implementation | Keep per host | host |
| Artifact sink/export contract | Introduce as shared metadata and lifecycle | upstream contract, host implementation |
| Interrupt/input contract | Introduce separately from permission and write-review approval | upstream |
| Approval UX | Keep host-native | host |

## Current Obsidian concerns that should stay host-native

- `Plugin` lifecycle
- `ItemView` and `WorkspaceLeaf` view ownership
- `MarkdownRenderer` usage
- ribbon and command registration
- settings tab and local persisted settings
- plugin integration discovery details
- vault-specific naming, folder choice, and file routing
- local modal flows for permission and write review

These are not portability problems. They are correct adapter responsibilities.

## Backlog consolidation map

| Current item | Disposition | Notes |
|---|---|---|
| `agents-js:evaluate-ag-ui-event-compatibility` | Superseded by umbrella host-kit contract item | AG-UI remains a reference input for shared event semantics |
| `agents-js:evaluate-generative-ui-extension-point` | Superseded by umbrella host-kit contract item | ACP elicitation remains an input to future interrupt/input design |
| `obsidian-acp-plugin:evaluate-ag-ui-event-model-for-rendering` | Superseded by umbrella host-kit contract item and plugin alignment item | Do not design plugin rendering in isolation |
| `obsidian-acp-plugin:evaluate-a2ui-component-catalog-for-tool-rendering` | Superseded by umbrella host-kit contract item and plugin alignment item | Treat component-catalog ideas as renderer-contract input |
| `obsidian-acp-plugin:evaluate-interrupt-aware-ui-for-permissions` | Superseded by umbrella host-kit contract item and plugin alignment item | Separate interrupt/input contract from host-owned approval UX |
| `obsidian-acp-plugin:evaluate-reporting-adapter-for-obsidian-artifacts` | Remains separate | Product-facing artifact work should follow the host-kit direction, not replace it |

## Near-term direction

The next exploration is upstream host-kit design.

That means:

- one umbrella design item upstream
- one plugin alignment item downstream
- no new runtime abstractions until this contract is agreed
- AG-UI and A2UI inform the model but do not dictate implementation
- reporting and artifact work stays plugin-owned once the host-kit direction is clear
