import { describe, expect, test } from "bun:test";
import { createPlaneWebhookFetchHandler } from "../src/webhook.ts";
import { buildPlaneRequest, TEST_PLANE_SECRET as SECRET } from "./helpers.ts";

describe("Plane webhook endpoint", () => {
  test("accepts a signed issue update whose state is Done and notifies once", async () => {
    const notifications: string[] = [];
    const logs: unknown[] = [];
    const body = JSON.stringify({
      event: "issue",
      action: "update",
      data: {
        id: "issue-1",
        identifier: "DOT",
        sequence_id: 301,
        name: "Plane webhook bridge",
        state_detail: { name: "Done" },
        project_detail: { identifier: "DOT" },
      },
    });

    const handler = createPlaneWebhookFetchHandler({
      secret: SECRET,
      notifyMatrix: async (message) => {
        notifications.push(message);
        return true;
      },
      logger: {
        log: (...args) => logs.push(args),
        warn: (...args) => logs.push(args),
        error: (...args) => logs.push(args),
      },
    });

    const response = await handler(buildPlaneRequest(body));

    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ ok: true, notified: true });
    expect(notifications).toEqual([
      "Plane issue Done: DOT-301 Plane webhook bridge (delivery delivery-123)",
    ]);
    expect(JSON.stringify(logs)).toContain("plane_webhook_issue_done");
  });

  test("rejects invalid signatures without notifying", async () => {
    const notifications: string[] = [];
    const body = JSON.stringify({
      event: "issue",
      action: "update",
      data: {
        name: "Should not notify",
        state_detail: { name: "Done" },
      },
    });
    const handler = createPlaneWebhookFetchHandler({
      secret: SECRET,
      notifyMatrix: async (message) => {
        notifications.push(message);
        return true;
      },
    });

    const response = await handler(buildPlaneRequest(body, "not-a-valid-signature"));

    expect(response).not.toBeNull();
    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({ ok: false, error: "Invalid signature" });
    expect(notifications).toEqual([]);
  });

  test("rejects non-POST webhook requests", async () => {
    const handler = createPlaneWebhookFetchHandler({ secret: SECRET });

    const response = await handler(new Request("http://127.0.0.1:9200/webhooks/plane"));

    expect(response).not.toBeNull();
    expect(response?.status).toBe(405);
    expect(await response?.json()).toMatchObject({
      ok: false,
      error: "Method Not Allowed",
    });
  });

  test("returns 503 when the mount cannot resolve a webhook secret", async () => {
    const handler = createPlaneWebhookFetchHandler({
      secretResolver: async () => null,
    });
    const body = JSON.stringify({
      event: "issue",
      action: "update",
      data: {
        identifier: "DOT",
        sequence_id: 301,
        name: "Plane webhook bridge",
        state_detail: { name: "Done" },
      },
    });

    const response = await handler(buildPlaneRequest(body));

    expect(response).not.toBeNull();
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({
      ok: false,
      error: "Webhook secret unavailable",
    });
  });

  test("returns 400 for signed invalid JSON bodies", async () => {
    const handler = createPlaneWebhookFetchHandler({ secret: SECRET });
    const body = "{";

    const response = await handler(buildPlaneRequest(body));

    expect(response).not.toBeNull();
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({
      ok: false,
      error: "Invalid JSON body",
    });
  });

  test("acknowledges non-Done issue updates without notifying", async () => {
    const notifications: string[] = [];
    const body = JSON.stringify({
      event: "issue",
      action: "update",
      data: {
        id: "issue-2",
        identifier: "DOT",
        sequence_id: 302,
        name: "Not done yet",
        state_detail: { name: "In Progress" },
      },
    });
    const handler = createPlaneWebhookFetchHandler({
      secret: SECRET,
      notifyMatrix: async (message) => {
        notifications.push(message);
        return true;
      },
    });

    const response = await handler(buildPlaneRequest(body));

    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      ok: true,
      ignored: true,
      reason: "not_issue_done",
    });
    expect(notifications).toEqual([]);
  });
});
