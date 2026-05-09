import { createHmac, timingSafeEqual } from "node:crypto";
import type { Logger } from "./logger.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const DEFAULT_PATH = "/webhooks/plane";

export interface PlaneWebhookFetchHandlerOptions {
  /** Request path that triggers this handler. Defaults to `/webhooks/plane`. */
  path?: string;
  /** Direct secret, mostly for tests. Production mounts should inject a resolver. */
  secret?: string;
  /** Async secret resolver. Mount points own env/gopass/secret-manager integration. */
  secretResolver?: () => Promise<string | null>;
  /** Optional notifier. Mount points own Matrix or other side-effect integrations. */
  notifyMatrix?: (message: string) => Promise<boolean>;
  logger?: Logger;
}

interface PlaneWebhookPayload {
  event?: unknown;
  action?: unknown;
  data?: unknown;
}

interface PlaneIssueData {
  id?: unknown;
  identifier?: unknown;
  sequence_id?: unknown;
  name?: unknown;
  state?: unknown;
  state_detail?: unknown;
  project_detail?: unknown;
}

export function createPlaneWebhookFetchHandler(
  options: PlaneWebhookFetchHandlerOptions = {},
): (req: Request) => Promise<Response | null> {
  const path = options.path ?? DEFAULT_PATH;
  const logger = options.logger ?? console;
  const resolveSecret = options.secretResolver ?? (async () => options.secret ?? null);
  const notifyMatrix = options.notifyMatrix ?? (async () => false);

  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    if (url.pathname !== path) {
      return null;
    }
    if (req.method !== "POST") {
      return jsonResponse(
        {
          ok: false,
          error: "Method Not Allowed",
          message: "Plane webhooks must use POST.",
        },
        405,
      );
    }

    // Body and secret have no data dependency on each other; resolving the
    // secret can race the body read, which matters when the secret resolver
    // is a gopass subprocess.
    const [secret, rawBody] = await Promise.all([resolveSecret(), req.text()]);
    if (!secret) {
      logger.error("[Plane] Missing webhook secret");
      return jsonResponse(
        {
          ok: false,
          error: "Webhook secret unavailable",
        },
        503,
      );
    }

    const signature = req.headers.get("x-plane-signature")?.trim() ?? "";
    const delivery = req.headers.get("x-plane-delivery")?.trim() ?? "unknown";
    const eventHeader = req.headers.get("x-plane-event")?.trim() ?? "unknown";

    if (!verifyPlaneSignature(rawBody, secret, signature)) {
      logger.warn("[Plane] Invalid webhook signature", {
        delivery,
        event: eventHeader,
      });
      return jsonResponse(
        {
          ok: false,
          error: "Invalid signature",
        },
        403,
      );
    }

    let payload: PlaneWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as PlaneWebhookPayload;
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          error: "Invalid JSON body",
          message: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }

    const issueDone = extractDoneIssue(payload);
    if (!issueDone) {
      logger.log("[Plane] plane_webhook_ignored", {
        delivery,
        event: payload.event ?? eventHeader,
        action: payload.action,
      });
      return jsonResponse({
        ok: true,
        ignored: true,
        reason: "not_issue_done",
      });
    }

    const message = formatIssueDoneMessage(issueDone, delivery);
    let notified = false;
    try {
      notified = await notifyMatrix(message);
    } catch (error) {
      logger.error("[Plane] Notifier failed", {
        delivery,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.log("[Plane] plane_webhook_issue_done", {
      delivery,
      event: payload.event ?? eventHeader,
      action: payload.action,
      issue: issueDone.key,
      name: issueDone.name,
      notified,
    });

    return jsonResponse({
      ok: true,
      notified,
      issue: issueDone.key,
    });
  };
}

export function verifyPlaneSignature(
  rawBody: string,
  secret: string,
  receivedSignature: string,
): boolean {
  if (!receivedSignature) return false;
  const expectedSignature = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expected = Buffer.from(expectedSignature, "utf8");
  const received = Buffer.from(receivedSignature, "utf8");
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

function extractDoneIssue(payload: PlaneWebhookPayload): {
  key: string;
  name: string;
} | null {
  if (payload.event !== "issue" || payload.action !== "update") {
    return null;
  }
  if (!payload.data || typeof payload.data !== "object") {
    return null;
  }

  const data = payload.data as PlaneIssueData;
  const stateName = extractStateName(data);
  if (stateName.toLowerCase() !== "done") {
    return null;
  }

  const projectIdentifier = extractNestedString(data.project_detail, "identifier");
  const identifier = stringValue(data.identifier) || projectIdentifier || "ISSUE";
  const sequenceId = stringValue(data.sequence_id) || stringValue(data.id) || "unknown";
  const name = stringValue(data.name) || "Untitled issue";

  return {
    key: `${identifier}-${sequenceId}`,
    name,
  };
}

function extractStateName(data: PlaneIssueData): string {
  const direct = stringValue(data.state);
  if (direct) return direct;
  const nestedStateName = extractNestedString(data.state, "name");
  if (nestedStateName) return nestedStateName;
  const stateDetailName = extractNestedString(data.state_detail, "name");
  if (stateDetailName) return stateDetailName;
  return "";
}

function extractNestedString(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  return stringValue(Reflect.get(value, key));
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function formatIssueDoneMessage(issue: { key: string; name: string }, delivery: string): string {
  return `Plane issue Done: ${issue.key} ${issue.name} (delivery ${delivery})`;
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}
