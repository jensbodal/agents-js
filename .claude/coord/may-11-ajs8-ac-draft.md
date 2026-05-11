# AJS-8 AC text draft (gateway server-push channel)

**Status**: DRAFT for Plane fold-in. Awaiting cognee-claude reviewer
signal on two open slot questions (see end). Local artifact under
`.claude/coord/`; canonical AC text lands in the AJS-8 Plane ticket.

## Title

**AJS-8 — Gateway server-push channel (event bus + SSE subscribe)**

## Scope (v1)

The agents-js gateway gains a server-initiated push channel that
publishes events to subscribed consumers without requiring polling.

V1 ships:

1. **Event bus primitive** inside the gateway process. In-memory pub/sub
   over a typed event envelope. Publishers register; subscribers attach;
   delivery is fan-out best-effort within the process.
2. **SSE subscribe transport** at a gateway-served HTTP endpoint.
   Long-lived `Content-Type: text/event-stream` response. Each subscribed
   client gets a per-connection delivery stream.
3. **Admin publish API** — an authenticated endpoint that lets operator
   tooling inject events onto the bus (e.g. for the Matrix bridge demo).
   Trusted-network/internal only in v1.
4. **Matrix bridge demo publisher** — one concrete publisher that turns
   selected Matrix events into bus events, demonstrating the
   bridge-to-bus pattern end-to-end.
5. **Internal publishers** — named producer roles inside the gateway
   that emit on the bus during normal operation. V1 set:
   - `gateway.session.*` — session-created, session-cancelled,
     session-harness-bound (consumes from existing
     ACPSessionController lifecycle)
   - `gateway.harness.*` — harness-child-spawned, harness-child-exited,
     harness-card-changed (anticipates AJS-7 multi-harness). **Also
     covers harness-level preflight/runtime failures
     (`model-unresolved`, `auth-failed`, `provider-unreachable`)
     surfaced via structured ACP notifications from in-repo harnesses**
     (`extras/pi-acp/`, `extras/droid-acp/`). The harness adapters
     translate upstream stderr/stdout warnings into typed ACP
     notifications at their own translator layer; the gateway consumes
     the structured notification and republishes on the bus. No stderr
     pattern-matching at the gateway layer. External harnesses
     (`claude-agent-acp`, `codex-acp`, `gemini-cli`) without structured
     emissions remain log-only in v1; upstream issues filed for them to
     add equivalent signals.
   - `gateway.permission.*` — permission-decision-recorded (lifts the
     existing audit emitter onto the bus surface)

## Event envelope

The bus carries events with this minimum envelope:

```typescript
interface GatewayBusEvent<TPayload = unknown> {
  // Event identity
  id: string;              // unique per event (v1 generator: UUID v4)
  type: string;            // dotted topic name, e.g. "gateway.session.created"
  ts: string;              // ISO-8601 UTC

  // Optional metadata slots (carried in v1 even with enforcement deferred)
  sourcePrincipal?: IdentityPrincipal;   // local placeholder type until DOT-392 phase 1 lands (see open Q1)
  correlationId?: string;                // ties related events together (see open Q2)

  // Payload — repo-specific data in named fields, NOT inlined into the envelope
  payload: TPayload;
}
```

## Scope guards (v1)

1. **Trusted-network / internal only.** No public-internet exposure.
   No auth-z enforcement on the SSE subscribe endpoint in v1. Document
   the deployment assumption.
2. **No JSON-RPC mutation.** The bus is a separate surface alongside
   the existing A2A JSON-RPC, ACP, and MCP wires. Do not alter or
   extend the JSON-RPC envelope shapes.
3. **No ACP/A2A semantic changes.** The bus reads from existing
   gateway state; it does not introduce new harness behaviors or
   change how A2A messages are processed.
4. **Repo-specific data in named payload fields.** Anything specific
   to agents-js (or repo-specific event semantics) belongs in
   `payload.*` or named metadata seams — never in the bus envelope's
   protocol-shaped fields. Keeps the envelope reusable.
5. **Metadata slots present, enforcement deferred.** `sourcePrincipal`
   and `correlationId` are optional in v1 — emitted by publishers where
   available, ignored by consumers if absent. V1 does not validate or
   reject events missing them. Slots exist so v2 enforcement can
   layer on without re-cutting the envelope.

## Out of scope (explicit)

- **MCP bridge / adapter component** — separate AJS ticket. A workload
  that subscribes to the gateway bus and re-emits as MCP
  `notifications/*` to MCP clients. Does NOT impersonate the gateway.
  Tracked separately because MCP transport semantics (server-initiated
  notifications over a client-opened JSON-RPC connection) require their
  own AC text on per-client connection-state tracking.
- **Federation** — gateway-to-gateway A2A subscribe is a follow-up.
  V1 is local-machine internal publishers + local subscribers.
- **Durable delivery / replay** — v1 is in-memory pub/sub. Subscribers
  miss events emitted while disconnected. Backed-storage durability is
  a v2 concern.
- **Identity enforcement** — metadata slot exists; verification machinery
  belongs to DOT-392 phase 2+.
- **@@dispatch hot-pool optimization** — separate from the bus; orthogonal.

## Acceptance criteria

- [ ] In-process event bus with publish() + subscribe() primitives,
      typed by `GatewayBusEvent<TPayload>`.
- [ ] HTTP endpoint serving SSE (`/events` or
      similar; final path TBD) — each connection receives a
      per-subscriber stream.
- [ ] Admin publish API (HTTP POST) gated to trusted-network in v1.
- [ ] Matrix bridge demo: a publisher that turns selected Matrix events
      into `gateway.matrix.*` bus events. Demonstrates one full
      Matrix → bridge → bus → SSE → consumer path.
- [ ] Three internal publishers wired: `gateway.session.*`,
      `gateway.harness.*`, `gateway.permission.*`.
- [ ] `gateway.harness.*` includes **structured failure events**
      sourced from in-repo harness ACP notifications. `extras/pi-acp/`
      and `extras/droid-acp/` translators emit ACP notifications for
      `model-unresolved`, `auth-failed`, `provider-unreachable`
      conditions; the gateway consumes them and republishes on the bus.
      External harnesses without structured emissions are out of scope
      for v1 (upstream issues filed; pattern-matching on stderr is
      explicitly rejected).
- [ ] Source principal + correlation metadata slots present in envelope
      (optional, non-enforcing in v1).
- [ ] Bus envelope schema documented + exported from a package consumers
      can import for type-safe subscribe.
- [ ] Test coverage:
  - Unit: publish/subscribe fan-out semantics
  - Integration: one publisher + one SSE subscriber, full
    Matrix-event-in / SSE-event-out cycle
  - Edge: subscriber disconnect mid-stream cleans up resources
    without leaking handlers

## Motivating real-world need (added 2026-05-11, revised)

`@jensbodal` observed pi-acp emitting `Warning: No models match pattern
"zai/glm-5.1"` (and similar for other zai patterns) into gateway
stderr during a real session. Today this warning is invisible to UI
clients — it's only in the gateway log. The v1 answer is to lift this
into a structured event the UI can surface as a user-actionable banner
("Pi harness has 3 unresolved model patterns — check zai
authentication").

**Approach (revised from earlier draft):** Pattern-matching on stderr
is explicitly rejected per `@jensbodal`'s feedback ("pattern matching
is horrible"). The structurally clean path is:

- **In-repo harnesses** (`extras/pi-acp/`, `extras/droid-acp/`) emit
  structured ACP notifications for these conditions. The harness
  adapter — which already sits between the upstream runtime's stderr
  and the ACP wire — does the translation at its own translator layer,
  not at the gateway. No regex on stderr at the gateway boundary.
- **Gateway** consumes the structured notifications via the existing
  ACP session-update path and republishes on the bus as
  `gateway.harness.model-unresolved`, `gateway.harness.auth-failed`,
  etc. Type-safe at every layer boundary.
- **External harnesses** (`claude-agent-acp`, `codex-acp`,
  `gemini-cli`) without structured emissions stay log-only in v1.
  Upstream issues filed to request structured signals. No regex
  workaround for these in v1.

Adding the in-repo harness work to AJS-8 v1 scope: pi-acp +
droid-acp translator layer changes are small (their structure already
lives there), but they DO require harness-package code edits.
Implementation-gated per the agents-js freeze; design decision lands
in this AC, execution awaits explicit owner approval.

## Cross-references

- **AJS-7** (multi-harness ordering): consumes bus events for
  per-session harness binding, agent-card capability changes, lane
  controller lifecycle. Federable to peer gateways if wire format is
  A2A-native.
- **DOT-392** (identity model): source principal slot is a local
  `IdentityPrincipal` placeholder in v1 (defined inline in
  `packages/host/src/gateway-bus.ts`). When DOT-392 phase 1 ships its
  shared identity types, the placeholder is replaced with the imported
  type. Open question Q1 below tracks the exact substitution.
- **MCP bridge ticket** (TBD): consumer of this bus. AJS-8 ships the
  bus; the MCP bridge ticket ships the MCP-side adapter.
- **`docs/_internal/agent-gateway-separation.md`**: anchor doc
  positioning AJS-8 in the host/gateway/runtime tripod (gateway-layer
  concern).

## Open coord questions (reviewer signal)

1. **Source principal slot type.** Two options:
   - **(a)** Type-only `IdentityMetadata` from DOT-392 phase 1.
     Optional, non-enforcing in v1. Locks the slot's eventual shape to
     phase-1 types.
   - **(b)** Local placeholder (`{ kind: string; id: string }` or
     similar) until DOT-392 phase 2 lands. Looser, easier to refactor
     when phase 2 ships.

   **Default-yes**: (a). Reuse DOT-392 phase 1 types where they exist.
   Acceptable because phase 1 is types-only with no runtime
   verification — using the types doesn't lock us into enforcement.

2. **Correlation slot.** Two options:
   - **(a)** Reuse `agents-js.correlationId` convention from
     `packages/host/src/host-executor.ts:797-801` and `:923-931`.
     Existing convention; consumers that already read it work
     unchanged.
   - **(b)** Invent a new bus-specific slot
     (`bus.correlationId`?) so bus events don't entangle with
     existing host-executor correlation semantics.

   **Default-yes**: (a). Reuse the existing convention; entanglement is
   a feature, not a bug — bus events that correlate with host-executor
   events should share the correlation ID.

cognee-claude (reviewer) — flag if either default-yes is wrong.

— ajs-claude (peer session) 2026-05-11
