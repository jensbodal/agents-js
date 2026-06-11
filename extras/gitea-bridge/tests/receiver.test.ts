/**
 * Learning tests for the Gitea webhook receiver endpoint
 * (`extras/gitea-bridge/src/receiver.ts`).
 *
 * Tests lock the AJS-59 v1 contract:
 * - HMAC verification on RAW body bytes BEFORE JSON parse
 * - Constant-time comparison (no timing leak)
 * - Per-repo allowlist + per-event-type allowlist (silent drop)
 * - Gateway-side dedupe via 1-hour TTL seen-set on `delivery_id`
 * - Bus envelope shape matches `@agents-js/gitea-bridge` contract
 *   (snake_case: `delivery_id`, `repo`, `event_type`, `action`, `actor`,
 *   `target_url`, `commit_sha`, `title`)
 *
 * Per the AJS-59 design exchange (matrix events
 * `$RzZMiZsjWu-BVVFN4bjs9mBwdkWHKmckLqxsz0XHlYU` → ratified at
 * `$ifDfwkeFHpbiSHTPGr2ZFD79050wy_WsIRhQytVaiEs`).
 */
import { describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { createGatewayBus, type GatewayBusEvent } from "@agents-js/host";
import { createGiteaWebhookHandler, GITEA_BRIDGE_EVENT_TOPIC } from "../src/index.ts";

const SECRET = "test-hmac-secret-xyz";

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function makeRequest(opts: {
  body: string;
  signature?: string;
  event?: string;
  delivery?: string;
  method?: string;
  path?: string;
}): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.signature !== undefined) headers["X-Gitea-Signature"] = opts.signature;
  if (opts.event !== undefined) headers["X-Gitea-Event"] = opts.event;
  if (opts.delivery !== undefined) headers["X-Gitea-Delivery"] = opts.delivery;

  return new Request(`http://localhost:9321${opts.path ?? "/webhooks/gitea"}`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body,
  });
}

function pullRequestPayload(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    action: "opened",
    number: 42,
    pull_request: {
      title: "feat: scaffold gitea webhook receiver",
      html_url: "https://gitea.q4m.dev/jensbodal/agents-js/pulls/42",
      head: { sha: "abc123def456" },
    },
    repository: { full_name: "jensbodal/agents-js" },
    sender: { login: "ajs-claude" },
    ...overrides,
  });
}

describe("createGiteaWebhookHandler — path routing", () => {
  test("returns null for non-matching path (falls through to next handler)", async () => {
    const bus = createGatewayBus();
    const handler = createGiteaWebhookHandler({ bus, secret: SECRET });
    const req = new Request("http://localhost:9321/some/other/path", { method: "POST" });
    expect(await handler(req)).toBeNull();
  });

  test("custom path option is honored", async () => {
    const bus = createGatewayBus();
    const handler = createGiteaWebhookHandler({
      bus,
      secret: SECRET,
      path: "/custom/gitea",
    });
    const req = new Request("http://localhost:9321/webhooks/gitea", { method: "POST" });
    expect(await handler(req)).toBeNull();
  });

  test("returns 405 for non-POST methods on the matching path", async () => {
    const bus = createGatewayBus();
    const handler = createGiteaWebhookHandler({ bus, secret: SECRET });
    const req = new Request("http://localhost:9321/webhooks/gitea", { method: "GET" });
    const res = await handler(req);
    expect(res?.status).toBe(405);
    expect(res?.headers.get("Allow")).toBe("POST");
  });
});

describe("createGiteaWebhookHandler — HMAC verification", () => {
  test("accepts a request with a valid HMAC signature", async () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => received.push(event));

    const handler = createGiteaWebhookHandler({ bus, secret: SECRET });
    const body = pullRequestPayload();
    const req = makeRequest({
      body,
      signature: sign(SECRET, body),
      event: "pull_request",
      delivery: randomUUID(),
    });

    const res = await handler(req);
    expect(res?.status).toBe(200);
    expect(received).toHaveLength(1);
  });

  test("accepts a signature with the optional sha256= prefix (GitHub-compat shape)", async () => {
    /**
     * WHAT: A signature sent as `sha256=<hex>` (GitHub-compatible
     *       convention, also seen from some Gitea reverse proxies)
     *       verifies identically to the bare-hex shape.
     * WHY: Mirrors the defensive prefix-strip in
     *      `dot-notification/src/services/signature_validator.py`.
     *      Without the strip, `Buffer.from("sha256=...", "hex")` would
     *      silently produce garbage bytes and verification would 401
     *      every legitimate request from those installations.
     */
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => received.push(event));

    const handler = createGiteaWebhookHandler({ bus, secret: SECRET });
    const body = pullRequestPayload();
    const req = makeRequest({
      body,
      signature: `sha256=${sign(SECRET, body)}`,
      event: "pull_request",
      delivery: randomUUID(),
    });

    const res = await handler(req);
    expect(res?.status).toBe(200);
    expect(received).toHaveLength(1);
  });

  test("rejects a request with an invalid HMAC signature (401, no publish)", async () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => received.push(event));

    const handler = createGiteaWebhookHandler({ bus, secret: SECRET });
    const body = pullRequestPayload();
    const req = makeRequest({
      body,
      signature: `deadbeef${sign(SECRET, body).slice(8)}`, // tampered
      event: "pull_request",
      delivery: randomUUID(),
    });

    const res = await handler(req);
    expect(res?.status).toBe(401);
    expect(received).toHaveLength(0);
  });

  test("rejects a request with a missing HMAC signature (401, no publish)", async () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => received.push(event));

    const handler = createGiteaWebhookHandler({ bus, secret: SECRET });
    const body = pullRequestPayload();
    const req = makeRequest({
      body,
      event: "pull_request",
      delivery: randomUUID(),
      // signature omitted
    });

    const res = await handler(req);
    expect(res?.status).toBe(401);
    expect(received).toHaveLength(0);
  });

  test("HMAC verifies against RAW body bytes (signature breaks if body modified)", async () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => received.push(event));

    const handler = createGiteaWebhookHandler({ bus, secret: SECRET });
    const originalBody = pullRequestPayload();
    const signature = sign(SECRET, originalBody);
    // Same logical JSON but byte-different (re-stringified with whitespace)
    const reparsed = JSON.parse(originalBody);
    const reformattedBody = JSON.stringify(reparsed, null, 2);
    expect(reformattedBody).not.toBe(originalBody);

    const req = makeRequest({
      body: reformattedBody,
      signature, // signature is for originalBody, not reformattedBody
      event: "pull_request",
      delivery: randomUUID(),
    });

    const res = await handler(req);
    expect(res?.status).toBe(401);
    expect(received).toHaveLength(0);
  });
});

describe("createGiteaWebhookHandler — body validation", () => {
  test("rejects malformed JSON (400)", async () => {
    const bus = createGatewayBus();
    const handler = createGiteaWebhookHandler({ bus, secret: SECRET });
    const body = "{not-json";
    const req = makeRequest({
      body,
      signature: sign(SECRET, body),
      event: "pull_request",
      delivery: randomUUID(),
    });
    const res = await handler(req);
    expect(res?.status).toBe(400);
  });

  test("rejects missing X-Gitea-Event header (400)", async () => {
    const bus = createGatewayBus();
    const handler = createGiteaWebhookHandler({ bus, secret: SECRET });
    const body = pullRequestPayload();
    const req = makeRequest({
      body,
      signature: sign(SECRET, body),
      delivery: randomUUID(),
      // event omitted
    });
    const res = await handler(req);
    expect(res?.status).toBe(400);
  });

  test("rejects missing X-Gitea-Delivery header (400)", async () => {
    const bus = createGatewayBus();
    const handler = createGiteaWebhookHandler({ bus, secret: SECRET });
    const body = pullRequestPayload();
    const req = makeRequest({
      body,
      signature: sign(SECRET, body),
      event: "pull_request",
      // delivery omitted
    });
    const res = await handler(req);
    expect(res?.status).toBe(400);
  });

  test("rejects payload missing repository.full_name (400)", async () => {
    const bus = createGatewayBus();
    const handler = createGiteaWebhookHandler({ bus, secret: SECRET });
    const body = JSON.stringify({
      action: "opened",
      sender: { login: "ajs-claude" },
      // repository.full_name missing
    });
    const req = makeRequest({
      body,
      signature: sign(SECRET, body),
      event: "pull_request",
      delivery: randomUUID(),
    });
    const res = await handler(req);
    expect(res?.status).toBe(400);
  });
});

describe("createGiteaWebhookHandler — allowlists (silent drop)", () => {
  test("silently drops repos not in the allowlist (200, no publish)", async () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => received.push(event));

    const handler = createGiteaWebhookHandler({
      bus,
      secret: SECRET,
      allowedRepos: ["jensbodal/agents-js"],
    });
    const body = pullRequestPayload({
      repository: { full_name: "other/repo" },
    });
    const req = makeRequest({
      body,
      signature: sign(SECRET, body),
      event: "pull_request",
      delivery: randomUUID(),
    });

    const res = await handler(req);
    expect(res?.status).toBe(200);
    expect(received).toHaveLength(0);
  });

  test("silently drops event types not in the allowlist (200, no publish)", async () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => received.push(event));

    const handler = createGiteaWebhookHandler({
      bus,
      secret: SECRET,
      allowedEventTypes: ["pull_request", "release"],
    });
    const body = pullRequestPayload();
    const req = makeRequest({
      body,
      signature: sign(SECRET, body),
      event: "issue_comment",
      delivery: randomUUID(),
    });

    const res = await handler(req);
    expect(res?.status).toBe(200);
    expect(received).toHaveLength(0);
  });

  test("allowlist empty/omitted means everything passes", async () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => received.push(event));

    const handler = createGiteaWebhookHandler({ bus, secret: SECRET });
    const body = pullRequestPayload();
    const req = makeRequest({
      body,
      signature: sign(SECRET, body),
      event: "pull_request",
      delivery: randomUUID(),
    });

    const res = await handler(req);
    expect(res?.status).toBe(200);
    expect(received).toHaveLength(1);
  });
});

describe("createGiteaWebhookHandler — bus envelope shape", () => {
  test("publishes a `gateway.gitea.event-received` envelope on success", async () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => received.push(event));

    const handler = createGiteaWebhookHandler({ bus, secret: SECRET });
    const deliveryId = randomUUID();
    const body = pullRequestPayload();
    const req = makeRequest({
      body,
      signature: sign(SECRET, body),
      event: "pull_request",
      delivery: deliveryId,
    });

    await handler(req);
    expect(received).toHaveLength(1);
    const env = received[0] as GatewayBusEvent<Record<string, unknown>>;
    expect(env.type).toBe(GITEA_BRIDGE_EVENT_TOPIC);
    expect(env.payload.delivery_id).toBe(deliveryId);
    expect(env.payload.repo).toBe("jensbodal/agents-js");
    expect(env.payload.event_type).toBe("pull_request");
    expect(env.payload.action).toBe("opened");
    expect(env.payload.actor).toBe("ajs-claude");
    expect(env.payload.target_url).toBe("https://gitea.q4m.dev/jensbodal/agents-js/pulls/42");
    expect(env.payload.commit_sha).toBe("abc123def456");
    expect(env.payload.title).toBe("feat: scaffold gitea webhook receiver");
    expect(env.sourcePrincipal?.kind).toBe("webhook");
    expect(env.sourcePrincipal?.id).toBe("gitea:jensbodal/agents-js:ajs-claude");
  });

  test("surfaces action=merged when a PR is closed with pull_request.merged=true", async () => {
    // Gitea sends action="closed" with merged=true on a merge; consumers must
    // be able to distinguish a merge from a close-without-merge.
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => received.push(event));

    const handler = createGiteaWebhookHandler({ bus, secret: SECRET });
    const body = pullRequestPayload({
      action: "closed",
      pull_request: {
        title: "feat: merged change",
        html_url: "https://gitea.q4m.dev/jensbodal/agents-js/pulls/42",
        head: { sha: "abc123def456" },
        merged: true,
      },
    });
    const req = makeRequest({
      body,
      signature: sign(SECRET, body),
      event: "pull_request",
      delivery: randomUUID(),
    });

    await handler(req);
    const env = received[0] as GatewayBusEvent<Record<string, unknown>>;
    expect(env.payload.action).toBe("merged");
  });

  test("keeps action=closed when a PR is closed without a merge", async () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => received.push(event));

    const handler = createGiteaWebhookHandler({ bus, secret: SECRET });
    const body = pullRequestPayload({
      action: "closed",
      pull_request: {
        title: "feat: rejected change",
        html_url: "https://gitea.q4m.dev/jensbodal/agents-js/pulls/42",
        head: { sha: "abc123def456" },
        merged: false,
      },
    });
    const req = makeRequest({
      body,
      signature: sign(SECRET, body),
      event: "pull_request",
      delivery: randomUUID(),
    });

    await handler(req);
    const env = received[0] as GatewayBusEvent<Record<string, unknown>>;
    expect(env.payload.action).toBe("closed");
  });

  test("extracts push event fields (commit_sha from `after`, target_url from `compare_url`)", async () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => received.push(event));

    const handler = createGiteaWebhookHandler({ bus, secret: SECRET });
    const body = JSON.stringify({
      ref: "refs/heads/main",
      after: "newsha789",
      before: "oldsha111",
      compare_url: "https://gitea.q4m.dev/jensbodal/agents-js/compare/oldsha111...newsha789",
      repository: { full_name: "jensbodal/agents-js" },
      pusher: { login: "ajs-claude" },
      sender: { login: "ajs-claude" },
    });
    const req = makeRequest({
      body,
      signature: sign(SECRET, body),
      event: "push",
      delivery: randomUUID(),
    });

    await handler(req);
    expect(received).toHaveLength(1);
    const env = received[0] as GatewayBusEvent<Record<string, unknown>>;
    expect(env.payload.event_type).toBe("push");
    expect(env.payload.commit_sha).toBe("newsha789");
    expect(env.payload.target_url).toBe(
      "https://gitea.q4m.dev/jensbodal/agents-js/compare/oldsha111...newsha789",
    );
  });

  test("extracts release event fields (target_url from release.html_url)", async () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => received.push(event));

    const handler = createGiteaWebhookHandler({ bus, secret: SECRET });
    const body = JSON.stringify({
      action: "created",
      release: {
        name: "v0.6.0",
        tag_name: "v0.6.0",
        html_url: "https://gitea.q4m.dev/jensbodal/agents-js/releases/tag/v0.6.0",
        target_commitish: "main",
      },
      repository: { full_name: "jensbodal/agents-js" },
      sender: { login: "ajs-claude" },
    });
    const req = makeRequest({
      body,
      signature: sign(SECRET, body),
      event: "release",
      delivery: randomUUID(),
    });

    await handler(req);
    expect(received).toHaveLength(1);
    const env = received[0] as GatewayBusEvent<Record<string, unknown>>;
    expect(env.payload.event_type).toBe("release");
    expect(env.payload.action).toBe("created");
    expect(env.payload.target_url).toBe(
      "https://gitea.q4m.dev/jensbodal/agents-js/releases/tag/v0.6.0",
    );
    expect(env.payload.title).toBe("v0.6.0");
  });
});

describe("createGiteaWebhookHandler — dedupe (1h TTL seen-set on delivery_id)", () => {
  test("dedupes repeat delivery_ids within TTL (only 1 publish)", async () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => received.push(event));

    const handler = createGiteaWebhookHandler({ bus, secret: SECRET });
    const deliveryId = randomUUID();
    const body = pullRequestPayload();

    // First send
    await handler(
      makeRequest({
        body,
        signature: sign(SECRET, body),
        event: "pull_request",
        delivery: deliveryId,
      }),
    );
    // Second send with same delivery_id (Gitea retry simulation)
    const res2 = await handler(
      makeRequest({
        body,
        signature: sign(SECRET, body),
        event: "pull_request",
        delivery: deliveryId,
      }),
    );

    expect(res2?.status).toBe(200); // dedupe response is still 200 (idempotent)
    expect(received).toHaveLength(1); // only 1 publish
  });

  test("repeat delivery_id AFTER TTL elapses produces 2 publishes", async () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => received.push(event));

    let nowMs = 1_000_000;
    const handler = createGiteaWebhookHandler({
      bus,
      secret: SECRET,
      dedupeTtlMs: 60_000, // 1min for test
      now: () => nowMs,
    });
    const deliveryId = randomUUID();
    const body = pullRequestPayload();

    await handler(
      makeRequest({
        body,
        signature: sign(SECRET, body),
        event: "pull_request",
        delivery: deliveryId,
      }),
    );

    // Advance time past TTL
    nowMs += 120_000;

    await handler(
      makeRequest({
        body,
        signature: sign(SECRET, body),
        event: "pull_request",
        delivery: deliveryId,
      }),
    );

    expect(received).toHaveLength(2);
  });

  test("different delivery_ids both publish (no false-positive dedupe)", async () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => received.push(event));

    const handler = createGiteaWebhookHandler({ bus, secret: SECRET });
    const body = pullRequestPayload();

    await handler(
      makeRequest({
        body,
        signature: sign(SECRET, body),
        event: "pull_request",
        delivery: randomUUID(),
      }),
    );
    await handler(
      makeRequest({
        body,
        signature: sign(SECRET, body),
        event: "pull_request",
        delivery: randomUUID(),
      }),
    );

    expect(received).toHaveLength(2);
  });

  test("dedupe disabled when dedupeTtlMs=0", async () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => received.push(event));

    const handler = createGiteaWebhookHandler({
      bus,
      secret: SECRET,
      dedupeTtlMs: 0,
    });
    const deliveryId = randomUUID();
    const body = pullRequestPayload();

    await handler(
      makeRequest({
        body,
        signature: sign(SECRET, body),
        event: "pull_request",
        delivery: deliveryId,
      }),
    );
    await handler(
      makeRequest({
        body,
        signature: sign(SECRET, body),
        event: "pull_request",
        delivery: deliveryId,
      }),
    );

    expect(received).toHaveLength(2);
  });
});
