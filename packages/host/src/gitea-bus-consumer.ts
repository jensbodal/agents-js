/**
 * Gitea bus consumer — subscribes to `gateway.gitea.event-received`,
 * formats a human-readable Matrix body, invokes the injected send
 * function (in production: `send-matrix.py` subprocess as `gitea-bot`
 * identity), logs send failures without taking down the subscription.
 *
 * AJS-59 v1 PR 3/3. Mirrors the shape of `matrix-bus-consumer.ts` but
 * intentionally simpler — Gitea events are one-way external-source
 * notifications, not bidirectional dispatch (no reply leg, no
 * `@@target` directive parsing, no dispatch handler injection).
 *
 * Architectural boundary: `@agents-js/host` defines the consumer
 * surface (subscribe + format + send) without pulling in the
 * `@agents-js/gitea-bridge` extras package — the payload type is a
 * structural duplicate to avoid a host → extras dependency cycle.
 * Same precedent as `matrix-bus-consumer.ts`'s `MatrixBusEventPayload`.
 *
 * Migration invariant (post-AJS-56): the `send` callback signature is
 * stable. Swapping from `send-matrix.py` subprocess to
 * `MatrixToolProvider.send` is a one-line wiring change at the
 * gateway-startup call site; the consumer code does not change.
 */

import type { GatewayBus, GatewayBusEvent, GatewayBusUnsubscribe } from "./gateway-bus.ts";

/** Canonical bus topic for Gitea webhook events. */
export const GITEA_BUS_CONSUMER_TOPIC = "gateway.gitea.event-received" as const;

/**
 * Default event-type allowlist per AJS-59 v1 design fold (matrix
 * event `$ifDfwkeFHpbiSHTPGr2ZFD79050wy_WsIRhQytVaiEs`):
 * `pull_request`, `push`, `release`, `check_run`. Other event types
 * (issue_comment, force-push, branch-create/delete, workflow lifecycle
 * intermediate states) are silently dropped at this layer.
 */
export const DEFAULT_GITEA_EVENT_TYPES: readonly string[] = [
  "pull_request",
  "push",
  "release",
  "check_run",
] as const;

/**
 * Structural duplicate of `@agents-js/gitea-bridge.GiteaBridgeEventInput`.
 * Kept here so `@agents-js/host` does not depend on the extras package.
 */
export interface GiteaBusEventPayload {
  delivery_id: string;
  repo: string;
  event_type: string;
  action?: string;
  actor: string;
  target_url?: string;
  commit_sha?: string;
  title?: string;
}

/**
 * Send-callback contract. Implementations:
 *
 * - **v1 (AJS-59 PR 3/3)**: subprocess wrapper around `send-matrix.py`
 *   that calls the script with the body + identity, surfacing
 *   non-zero exit codes as thrown errors.
 * - **post-AJS-56**: thin adapter onto `MatrixToolProvider.send`
 *   (verified via AJS-57 JWT). Same contract; different substrate.
 *
 * Errors thrown from `send` are caught by the consumer and logged
 * without propagating — one bad event does not take down the
 * subscription.
 */
export type GiteaSendFunction = (args: {
  body: string;
  identity: string;
  /** Optional room override; consumer passes whatever was configured at startup. */
  room?: string;
}) => Promise<void>;

/** Options for {@link startGiteaBusConsumer}. */
export interface StartGiteaBusConsumerOptions {
  /** The bus to subscribe on. */
  bus: GatewayBus;
  /** Send callback (subprocess-wrapped `send-matrix.py` in production). */
  send: GiteaSendFunction;
  /** Matrix identity to send AS. Defaults to `"gitea-bot"`. */
  identity?: string;
  /** Target room (passed through to the send callback). */
  room?: string;
  /**
   * Event-type allowlist. Defaults to {@link DEFAULT_GITEA_EVENT_TYPES}.
   * Events whose `event_type` is not in this list are silently dropped.
   */
  allowedEventTypes?: readonly string[];
  /** Optional logger. Defaults to console. */
  logger?: Pick<Console, "warn" | "error" | "log">;
}

/** Handle returned from {@link startGiteaBusConsumer}. */
export interface GiteaBusConsumerHandle {
  /** Unsubscribe from the bus. Idempotent. */
  stop(): void;
}

/**
 * Start the consumer. Returns a handle whose `stop()` unsubscribes.
 *
 * Per olthoi0-codex-app's validation checklist (matrix event
 * `$ZpdDO3B7H_Li8JeYBgzT8XwhOm5TEb7DIk8D67HeUZ0`):
 * - formats Gitea bus event into Matrix output
 * - ignored/malformed events do not send
 * - subprocess failure surfaced without taking down the subscription
 */
export function startGiteaBusConsumer(
  options: StartGiteaBusConsumerOptions,
): GiteaBusConsumerHandle {
  const identity = options.identity ?? "gitea-bot";
  const allowedEventTypes = options.allowedEventTypes ?? DEFAULT_GITEA_EVENT_TYPES;
  const logger = options.logger ?? console;

  const unsubscribe: GatewayBusUnsubscribe = options.bus.subscribe(
    async (event: GatewayBusEvent<unknown>) => {
      if (event.type !== GITEA_BUS_CONSUMER_TOPIC) return;

      // Structural-validate the payload. Drop silently on any missing
      // required field — malformed events are NOT a consumer error,
      // they're a producer contract violation that the receiver should
      // have caught upstream.
      const payload = event.payload;
      if (!isGiteaPayload(payload)) {
        logger.warn("[gitea-bus-consumer] dropped malformed payload", {
          delivery_id:
            typeof payload === "object" && payload && "delivery_id" in payload
              ? (payload as { delivery_id?: unknown }).delivery_id
              : undefined,
        });
        return;
      }

      // Event-type allowlist (consumer-level filter; the receiver also
      // has its own allowlist).
      if (!allowedEventTypes.includes(payload.event_type)) {
        return;
      }

      const body = formatGiteaMatrixBody(payload);

      try {
        await options.send({ body, identity, room: options.room });
      } catch (err) {
        // Per olthoi0-codex-app + cognee-claude: send failure logs +
        // continues. One bad subprocess invocation does NOT take down
        // the subscription. Future durable-queue / retry-backoff is
        // explicitly out of v1 scope (dot-notify v2 territory).
        logger.warn("[gitea-bus-consumer] send-failed", {
          delivery_id: payload.delivery_id,
          repo: payload.repo,
          event_type: payload.event_type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  return {
    stop: () => {
      unsubscribe();
    },
  };
}

/**
 * Format a Gitea bus event payload into a human-readable Matrix
 * message body.
 *
 * Shape: `[gitea/<repo>] <subject> by <actor>[: <title>][ — <target_url>]`
 *
 * Where `<subject>` is event-type-specific:
 * - `pull_request` → `PR <action>` (e.g. "PR opened", "PR merged")
 * - `push` → `push`
 * - `release` → `release <action>` (e.g. "release created")
 * - `check_run` → `check_run <action>` (e.g. "check_run completed")
 * - other types → `<event_type>[ <action>]`
 *
 * Exported for unit-test coverage of each event-type shape.
 */
export function formatGiteaMatrixBody(payload: GiteaBusEventPayload): string {
  const subject = formatSubject(payload);
  const titlePart = payload.title ? `: ${payload.title}` : "";
  const urlPart = payload.target_url ? ` — ${payload.target_url}` : "";
  return `[gitea/${payload.repo}] ${subject} by ${payload.actor}${titlePart}${urlPart}`;
}

function formatSubject(payload: GiteaBusEventPayload): string {
  const { event_type, action } = payload;
  if (event_type === "pull_request") {
    return action ? `PR ${action}` : "PR";
  }
  if (event_type === "push") {
    return "push";
  }
  // release, check_run, and unknown types — render as `<event_type>[ <action>]`
  return action ? `${event_type} ${action}` : event_type;
}

function isGiteaPayload(payload: unknown): payload is GiteaBusEventPayload {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.delivery_id === "string" &&
    typeof p.repo === "string" &&
    typeof p.event_type === "string" &&
    typeof p.actor === "string"
  );
}
