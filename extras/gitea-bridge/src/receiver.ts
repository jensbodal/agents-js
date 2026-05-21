/**
 * Gitea webhook receiver endpoint for the gateway bus.
 *
 * Mounted via the agents-js gateway's `additionalFetch` chain
 * (typically at `/webhooks/gitea`). HMAC-verifies the incoming Gitea
 * webhook payload against a shared secret (gopass-resolved server-
 * side), extracts the relevant fields per event type, and publishes
 * a typed envelope onto the gateway bus via {@link publishGiteaEventToBus}.
 *
 * Security boundary:
 * - HMAC verification is performed on the RAW body bytes BEFORE JSON
 *   parsing, so the signature covers exactly what the client sent.
 * - Constant-time comparison (`crypto.timingSafeEqual`) is used for
 *   the signature equality check to avoid timing leaks.
 * - Per-repo and per-event-type allowlists are evaluated AFTER HMAC
 *   verification, so unauthorized callers don't get info-leak about
 *   the filter shape.
 * - Gateway-side dedupe via in-memory TTL seen-set on the Gitea
 *   `X-Gitea-Delivery` header value (1-hour default TTL). Replay
 *   events (Gitea retries on consumer 5xx) collapse at the gateway.
 *
 * Per AJS-59 design exchange (matrix events
 * `$RzZMiZsjWu-BVVFN4bjs9mBwdkWHKmckLqxsz0XHlYU` →
 * `$ifDfwkeFHpbiSHTPGr2ZFD79050wy_WsIRhQytVaiEs`).
 *
 * Migration invariant: post-AJS-56 the bus envelope shape does NOT
 * change. Only the downstream consumer (`gitea-bus-consumer.ts`)
 * swaps its matrix-output leg from `send-matrix.py` subprocess to
 * `MatrixToolProvider.send`. The receiver stays as-is.
 *
 * Package home: this receiver lives in `extras/gitea-bridge/`
 * alongside the envelope builder. The dependency direction is
 * gitea-bridge → host (one-way), matching the matrix-bridge pattern.
 * Putting the receiver in host would create a circular dependency.
 */

import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { HTTP_STATUS } from "@agents-js/a2a";
import type { GatewayBus } from "@agents-js/host";
import { type GiteaBridgeEventInput, publishGiteaEventToBus } from "./index.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const DEFAULT_PATH = "/webhooks/gitea";
const DEFAULT_DEDUPE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Options for {@link createGiteaWebhookHandler}. */
export interface CreateGiteaWebhookHandlerOptions {
  /** Bus to publish verified events onto. */
  bus: GatewayBus;
  /**
   * HMAC shared secret. Required. Operator resolves this from gopass
   * (`services/agents-js/webhooks/gitea/hmac-secret` by convention)
   * and passes the value at handler-construction time. Never accepted
   * from request args.
   */
  secret: string;
  /** Endpoint path. Defaults to `/webhooks/gitea`. */
  path?: string;
  /** Optional logger. Defaults to console. */
  logger?: Pick<Console, "warn" | "error" | "log">;
  /**
   * Per-repo allowlist. When non-empty, only payloads whose
   * `repository.full_name` matches one of these are published; others
   * are silently dropped (200 OK with `{accepted: false, reason: ...}`
   * body, no bus publish). When empty or omitted, all repos pass.
   */
  allowedRepos?: readonly string[];
  /**
   * Per-event-type allowlist (matches `X-Gitea-Event` header). When
   * non-empty, only matching event types are published; others are
   * silently dropped. When empty or omitted, all event types pass.
   */
  allowedEventTypes?: readonly string[];
  /**
   * In-memory dedupe TTL in milliseconds. Replays of the same
   * `X-Gitea-Delivery` value within this window are dropped (200 OK,
   * no second publish). Defaults to 1 hour. Set to `0` to disable
   * dedupe (only sensible in tests).
   */
  dedupeTtlMs?: number;
  /**
   * Time source for dedupe TTL math. Defaults to `Date.now`.
   * Injectable for tests.
   */
  now?: () => number;
}

/**
 * Build a `POST /webhooks/gitea` handler that verifies the Gitea HMAC
 * signature, extracts event fields, and publishes a typed envelope
 * onto the supplied bus. Returns `null` for non-matching paths so the
 * caller can fall through to the next handler.
 */
export function createGiteaWebhookHandler(
  options: CreateGiteaWebhookHandlerOptions,
): (req: Request) => Promise<Response | null> {
  const path = options.path ?? DEFAULT_PATH;
  const logger = options.logger ?? console;
  const dedupeTtlMs = options.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const seenDeliveries = new Map<string, number>(); // delivery_id -> expiry epoch ms

  const secretBuf = Buffer.from(options.secret, "utf8");
  if (secretBuf.length === 0) {
    throw new Error("[gitea-webhook] secret must be non-empty");
  }

  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    if (url.pathname !== path) return null;
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "method not allowed" }), {
        status: HTTP_STATUS.METHOD_NOT_ALLOWED,
        headers: { ...JSON_HEADERS, Allow: "POST" },
      });
    }

    // 1. HMAC verify on RAW body BEFORE JSON parse.
    const rawBody = await req.text();
    const signature = req.headers.get("X-Gitea-Signature");
    if (!signature || !verifyHmac(options.secret, rawBody, signature)) {
      return new Response(JSON.stringify({ error: "invalid signature" }), {
        status: HTTP_STATUS.UNAUTHORIZED,
        headers: JSON_HEADERS,
      });
    }

    // 2. Required headers (post-HMAC so unauthorized callers don't
    // learn the requirements).
    const eventType = req.headers.get("X-Gitea-Event");
    const deliveryId = req.headers.get("X-Gitea-Delivery");
    if (!eventType) {
      return new Response(JSON.stringify({ error: "missing X-Gitea-Event header" }), {
        status: HTTP_STATUS.BAD_REQUEST,
        headers: JSON_HEADERS,
      });
    }
    if (!deliveryId) {
      return new Response(JSON.stringify({ error: "missing X-Gitea-Delivery header" }), {
        status: HTTP_STATUS.BAD_REQUEST,
        headers: JSON_HEADERS,
      });
    }

    // 3. Parse JSON (post-HMAC).
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch (err) {
      logger.warn("[gitea-webhook] invalid JSON body", {
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response(JSON.stringify({ error: "invalid JSON body" }), {
        status: HTTP_STATUS.BAD_REQUEST,
        headers: JSON_HEADERS,
      });
    }

    // 4. Extract repository.full_name (required for all event types).
    const repo = extractRepo(payload);
    if (!repo) {
      return new Response(JSON.stringify({ error: "payload missing repository.full_name" }), {
        status: HTTP_STATUS.BAD_REQUEST,
        headers: JSON_HEADERS,
      });
    }

    // 5. Allowlist filters (silent drop, 200 OK, no publish).
    if (options.allowedRepos && options.allowedRepos.length > 0) {
      if (!options.allowedRepos.includes(repo)) {
        return new Response(JSON.stringify({ accepted: false, reason: "repo not in allowlist" }), {
          status: HTTP_STATUS.OK,
          headers: JSON_HEADERS,
        });
      }
    }
    if (options.allowedEventTypes && options.allowedEventTypes.length > 0) {
      if (!options.allowedEventTypes.includes(eventType)) {
        return new Response(
          JSON.stringify({ accepted: false, reason: "event type not in allowlist" }),
          { status: HTTP_STATUS.OK, headers: JSON_HEADERS },
        );
      }
    }

    // 6. Dedupe check (after HMAC + allowlist; before publish).
    if (dedupeTtlMs > 0) {
      const nowMs = now();
      gcSeenDeliveries(seenDeliveries, nowMs);
      const seenExpiry = seenDeliveries.get(deliveryId);
      if (seenExpiry !== undefined && seenExpiry > nowMs) {
        logger.warn("[gitea-webhook] duplicate delivery suppressed", {
          deliveryId,
          repo,
        });
        return new Response(JSON.stringify({ accepted: false, reason: "duplicate delivery_id" }), {
          status: HTTP_STATUS.OK,
          headers: JSON_HEADERS,
        });
      }
      seenDeliveries.set(deliveryId, nowMs + dedupeTtlMs);
    }

    // 7. Extract event-specific fields + publish.
    const giteaEvent = extractEventFields({
      deliveryId,
      repo,
      eventType,
      payload,
    });

    publishGiteaEventToBus({
      bus: options.bus,
      giteaEvent,
    });

    return new Response(JSON.stringify({ accepted: true, delivery_id: deliveryId }), {
      status: HTTP_STATUS.OK,
      headers: JSON_HEADERS,
    });
  };
}

/**
 * Verify a Gitea HMAC signature against the raw request body, using
 * the shared secret. Constant-time comparison via `timingSafeEqual`.
 *
 * Gitea signs with HMAC-SHA256, hex-encoded. Sent in `X-Gitea-Signature`.
 *
 * Defensive prefix-strip: some Gitea installations and reverse proxies
 * send the signature with a leading `sha256=` (GitHub-compatible
 * convention) even though Gitea's documented format is bare hex. Mirror
 * the strip from `dot-notification/src/services/signature_validator.py`
 * so both shapes verify identically.
 */
function verifyHmac(secret: string, body: string, providedSig: string): boolean {
  const normalized = providedSig.startsWith("sha256=")
    ? providedSig.slice("sha256=".length)
    : providedSig;
  const expectedHex = createHmac("sha256", secret).update(body).digest("hex");
  const expected = Buffer.from(expectedHex, "hex");
  const provided = Buffer.from(normalized, "hex");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/** Extract `repository.full_name` from any Gitea event payload. */
function extractRepo(payload: Record<string, unknown>): string | undefined {
  const repository = payload.repository as Record<string, unknown> | undefined;
  const fullName = repository?.full_name;
  return typeof fullName === "string" && fullName.length > 0 ? fullName : undefined;
}

/**
 * Extract the agents-js gitea-bridge envelope fields per event type.
 *
 * For the AJS-59 v1 event allowlist (`pull_request`, `push`, `release`,
 * `check_run`), pull the relevant action/target_url/commit_sha/title.
 * Unknown event types still publish (with `action`/`target_url` etc.
 * extracted best-effort or omitted).
 */
function extractEventFields(input: {
  deliveryId: string;
  repo: string;
  eventType: string;
  payload: Record<string, unknown>;
}): GiteaBridgeEventInput {
  const { deliveryId, repo, eventType, payload } = input;
  const sender = payload.sender as Record<string, unknown> | undefined;
  const actor = (sender?.login as string) ?? "unknown";
  const action =
    typeof payload.action === "string" && payload.action.length > 0
      ? (payload.action as string)
      : undefined;

  const base: GiteaBridgeEventInput = {
    delivery_id: deliveryId,
    repo,
    event_type: eventType,
    actor,
    ...(action !== undefined ? { action } : {}),
  };

  switch (eventType) {
    case "pull_request": {
      const pr = payload.pull_request as Record<string, unknown> | undefined;
      const head = pr?.head as Record<string, unknown> | undefined;
      return {
        ...base,
        ...(typeof pr?.html_url === "string" ? { target_url: pr.html_url } : {}),
        ...(typeof head?.sha === "string" ? { commit_sha: head.sha } : {}),
        ...(typeof pr?.title === "string" ? { title: pr.title } : {}),
      };
    }
    case "push": {
      const compareUrl = payload.compare_url;
      const after = payload.after;
      const ref = payload.ref;
      return {
        ...base,
        ...(typeof compareUrl === "string" ? { target_url: compareUrl } : {}),
        ...(typeof after === "string" ? { commit_sha: after } : {}),
        ...(typeof ref === "string" ? { title: `push to ${ref}` } : {}),
      };
    }
    case "release": {
      const release = payload.release as Record<string, unknown> | undefined;
      return {
        ...base,
        ...(typeof release?.html_url === "string" ? { target_url: release.html_url } : {}),
        ...(typeof release?.target_commitish === "string"
          ? { commit_sha: release.target_commitish }
          : {}),
        ...(typeof release?.name === "string" ? { title: release.name } : {}),
      };
    }
    case "check_run": {
      const checkRun = payload.check_run as Record<string, unknown> | undefined;
      return {
        ...base,
        ...(typeof checkRun?.html_url === "string" ? { target_url: checkRun.html_url } : {}),
        ...(typeof checkRun?.head_sha === "string" ? { commit_sha: checkRun.head_sha } : {}),
        ...(typeof checkRun?.name === "string" ? { title: checkRun.name } : {}),
      };
    }
    default:
      return base;
  }
}

/**
 * Garbage-collect expired dedupe entries. Runs inline on each request
 * (cheap for the v1 expected volume; if it ever becomes a hot path,
 * move to a setInterval timer).
 */
function gcSeenDeliveries(seen: Map<string, number>, nowMs: number): void {
  for (const [id, expiry] of seen.entries()) {
    if (expiry <= nowMs) seen.delete(id);
  }
}
