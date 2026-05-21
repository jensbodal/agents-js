/**
 * Gitea webhook bridge publisher.
 *
 * Thin wrapper over `@agents-js/host`'s generic
 * {@link buildBridgeBusEvent} / {@link publishBridgeEventToBus}
 * primitives. The core agents-js packages stay source-agnostic; this
 * package adds the Gitea-specific knobs (canonical topic, actor →
 * source-principal mapping, the payload shape mirroring the subset of
 * Gitea webhook fields the receiver extracts).
 *
 * Architectural boundary: `@agents-js/host` ships the generic bridge
 * primitive and never mentions Gitea; this package depends on host
 * one-way and adds the Gitea-flavored defaults. Same pattern as
 * `@agents-js/matrix-bridge`. Any future webhook source (GitHub,
 * Plane, Slack) gets its own `@agents-js/<source>-bridge` extras
 * package alongside this one and reuses the same host primitive.
 *
 * Why ship a builder when the receiver lives inside `@agents-js/host`?
 *
 * 1. **Reference shape.** The receiver in `gitea-webhook.ts` and any
 *    in-process tests or future Gitea consumers need to produce
 *    envelopes that match what `/admin/publish` validates and what
 *    SSE subscribers can statically type against. A canonical TS
 *    builder eliminates drift.
 * 2. **Source-principal convention.** Gitea events have a natural
 *    source identity (`gitea:<repo>:<actor>`). Centralizing the
 *    default mapping here keeps audit/correlation surfaces consistent
 *    across receiver variants and tests.
 *
 * Topic naming
 *
 * V1 emits a single topic — `gateway.gitea.event-received`. Finer
 * routing (per-event-type, per-repo, etc.) is a consumer-side concern;
 * for v1 the consumer filters on `payload.event_type` /
 * `payload.repo` if it wants narrower selection.
 *
 * Field naming
 *
 * Bus envelope payload fields use `snake_case` (per AJS-59 design
 * exchange) to match Gitea source-field convention and stay cross-
 * language friendly for non-TS subscribers. The TypeScript interface
 * below preserves `snake_case` end-to-end for serialization simplicity.
 */

import {
  buildBridgeBusEvent,
  type GatewayBus,
  type GatewayBusEvent,
  type IdentityPrincipal,
  publishBridgeEventToBus,
} from "@agents-js/host";

/**
 * Minimum Gitea webhook payload shape that the gateway bridge contract
 * accepts. Mirrors the subset of fields the receiver in
 * `packages/host/src/gitea-webhook.ts` extracts from incoming
 * `pull_request` / `push` / `release` / `check_run` events. All
 * extension fields are intentionally absent — receivers that need
 * richer payloads must publish a different topic.
 */
export interface GiteaBridgeEventInput {
  /** Gitea `X-Gitea-Delivery` header value — dedupe key. */
  delivery_id: string;
  /** Repository identifier (`<owner>/<name>`), e.g. `jensbodal/agents-js`. */
  repo: string;
  /** Gitea event type, e.g. `"pull_request"`, `"push"`, `"release"`, `"check_run"`. */
  event_type: string;
  /** Event action, e.g. `"opened"`, `"merged"`, `"completed"`. */
  action?: string;
  /** Actor that triggered the event (`sender.login` in the gitea payload). */
  actor: string;
  /** Browser-facing URL for the event subject (PR url, release url, etc.). */
  target_url?: string;
  /** Commit/head SHA when applicable (push events, PR head ref, etc.). */
  commit_sha?: string;
  /** Optional human-readable title (PR title, release name, push branch). */
  title?: string;
}

/** Topic for every Gitea bridge event in v1. */
export const GITEA_BRIDGE_EVENT_TOPIC = "gateway.gitea.event-received" as const;

/** Canonical `kind` for Gitea-sourced source principals. */
export const GITEA_SOURCE_PRINCIPAL_KIND = "webhook" as const;

/** Options for {@link buildGiteaBusEvent}. */
export interface BuildGiteaBusEventOptions {
  /** The Gitea webhook event to translate. */
  giteaEvent: GiteaBridgeEventInput;
  /**
   * Optional correlation token threaded through downstream
   * consumers. Useful when one Gitea event triggers a multi-step
   * gateway operation (e.g. routing + matrix notice + agent dispatch)
   * and the bus subscriber wants to follow the full causal chain.
   */
  correlationId?: string;
  /**
   * Source-principal override. Defaults to
   * `{ kind: "webhook", id: "gitea:<repo>:<actor>" }` so subscribers
   * can filter events by Gitea actor without parsing the payload.
   */
  sourcePrincipal?: IdentityPrincipal;
}

/**
 * Build a `gateway.gitea.event-received` bus envelope from a Gitea
 * webhook event. The returned envelope is ready to be `bus.publish(...)`'d
 * in-process by the receiver, or serialized into the `/admin/publish`
 * JSON body for out-of-process bridges.
 *
 * The Gitea event becomes the envelope `payload` verbatim — no field
 * renaming, no content stripping. Subscribers see exactly what the
 * receiver captured.
 */
export function buildGiteaBusEvent(
  options: BuildGiteaBusEventOptions,
): GatewayBusEvent<GiteaBridgeEventInput> {
  return buildBridgeBusEvent<GiteaBridgeEventInput>({
    topic: GITEA_BRIDGE_EVENT_TOPIC,
    payload: options.giteaEvent,
    sourcePrincipal:
      options.sourcePrincipal ??
      defaultGiteaSourcePrincipal(options.giteaEvent.repo, options.giteaEvent.actor),
    correlationId: options.correlationId,
  });
}

/** Options for {@link publishGiteaEventToBus}. */
export interface PublishGiteaEventToBusOptions extends BuildGiteaBusEventOptions {
  /** The bus to publish onto. */
  bus: GatewayBus;
}

/**
 * In-process convenience: build the envelope and publish it on the
 * supplied bus. Returns the envelope so callers can inspect/assert
 * on the server-populated `id` + `ts` fields.
 *
 * The in-process gateway receiver uses this directly. Out-of-process
 * bridges (if any) would build the envelope with {@link buildGiteaBusEvent}
 * and POST it to `/admin/publish` over HTTP.
 */
export function publishGiteaEventToBus(
  options: PublishGiteaEventToBusOptions,
): GatewayBusEvent<GiteaBridgeEventInput> {
  return publishBridgeEventToBus<GiteaBridgeEventInput>({
    bus: options.bus,
    topic: GITEA_BRIDGE_EVENT_TOPIC,
    payload: options.giteaEvent,
    sourcePrincipal:
      options.sourcePrincipal ??
      defaultGiteaSourcePrincipal(options.giteaEvent.repo, options.giteaEvent.actor),
    correlationId: options.correlationId,
  });
}

function defaultGiteaSourcePrincipal(repo: string, actor: string): IdentityPrincipal {
  return { kind: GITEA_SOURCE_PRINCIPAL_KIND, id: `gitea:${repo}:${actor}` };
}
