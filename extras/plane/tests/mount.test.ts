import { describe, expect, test } from "bun:test";
import { createPlaneWebhookFetchHandler } from "../src/mount.ts";
import { buildPlaneRequest, TEST_PLANE_SECRET as SECRET, signPlaneBody } from "./helpers.ts";

describe("Plane mount", () => {
  test("env-driven mount resolves PLANE_WEBHOOK_SECRET and processes a signed Done issue", async () => {
    const logs: unknown[] = [];
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

    const handler = createPlaneWebhookFetchHandler({
      env: { PLANE_WEBHOOK_SECRET: SECRET },
      logger: {
        log: (...args) => logs.push(args),
        warn: (...args) => logs.push(args),
        error: (...args) => logs.push(args),
      },
    });

    const response = await handler(buildPlaneRequest(body, signPlaneBody(body), "delivery-mount"));

    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ ok: true, notified: false });
    expect(JSON.stringify(logs)).toContain("notification disabled by env");
  });

  test("env-driven mount honors caller-provided secretResolver override", async () => {
    const handler = createPlaneWebhookFetchHandler({
      env: {},
      secretResolver: async () => null,
    });

    const response = await handler(buildPlaneRequest("{}", "irrelevant"));

    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({
      ok: false,
      error: "Webhook secret unavailable",
    });
  });
});
