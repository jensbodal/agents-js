/**
 * Learning tests for the Gitea bus consumer
 * (`packages/host/src/gitea-bus-consumer.ts`).
 *
 * Per AJS-59 v1 PR 3/3 contract (olthoi0-codex-app validation
 * checklist + cognee-claude design):
 * - Subscribes to `gateway.gitea.event-received`, filters by event-type
 *   allowlist (default: pull_request, push, release, check_run)
 * - Formats Gitea bus event into a human-readable Matrix body
 *   (`[gitea/<repo>] <action> #<N> by <actor>: <title> — <target_url>`)
 * - Invokes injected send function (in production: `send-matrix.py`
 *   subprocess as `gitea-bot` identity)
 * - Malformed events: drop silently (no send, no exception thrown
 *   out of handler)
 * - Send failures: log + continue (subscription stays alive; one
 *   bad event does not take down the consumer)
 * - `stop()` unsubscribes
 *
 * Migration invariant: post-AJS-56 the `send` injection swaps from
 * `send-matrix.py` subprocess to `MatrixToolProvider.send`. The
 * consumer's contract is the send function shape, not the substrate.
 */
import { describe, expect, test } from "bun:test";
import { createGatewayBus } from "../src/gateway-bus.ts";
import {
  formatGiteaMatrixBody,
  GITEA_BUS_CONSUMER_TOPIC,
  startGiteaBusConsumer,
} from "../src/gitea-bus-consumer.ts";

interface SendCall {
  body: string;
  identity: string;
}

function makeMockSender() {
  const calls: SendCall[] = [];
  const sender = async (args: { body: string; identity: string }): Promise<void> => {
    calls.push({ body: args.body, identity: args.identity });
  };
  return { sender, calls };
}

function makeFailingSender(error = new Error("send-matrix.py exited 1")) {
  const calls: { body: string }[] = [];
  const sender = async (args: { body: string; identity: string }): Promise<void> => {
    calls.push({ body: args.body });
    throw error;
  };
  return { sender, calls };
}

function publishGiteaEvent(
  bus: ReturnType<typeof createGatewayBus>,
  payload: Record<string, unknown>,
): void {
  bus.publish({
    id: `evt-${Math.random().toString(36).slice(2, 10)}`,
    ts: new Date().toISOString(),
    type: GITEA_BUS_CONSUMER_TOPIC,
    payload,
  });
}

describe("startGiteaBusConsumer — subscription wiring", () => {
  test("subscribes to `gateway.gitea.event-received` topic", async () => {
    const bus = createGatewayBus();
    const { sender, calls } = makeMockSender();
    const handle = startGiteaBusConsumer({ bus, send: sender });

    publishGiteaEvent(bus, {
      delivery_id: "d1",
      repo: "jensbodal/agents-js",
      event_type: "pull_request",
      action: "opened",
      actor: "ajs-claude",
      title: "feat: scaffold consumer",
      target_url: "https://gitea.q4m.dev/jensbodal/agents-js/pulls/42",
    });
    await Bun.sleep(10);

    expect(calls).toHaveLength(1);
    handle.stop();
  });

  test("ignores events on other topics", async () => {
    const bus = createGatewayBus();
    const { sender, calls } = makeMockSender();
    const handle = startGiteaBusConsumer({ bus, send: sender });

    bus.publish({
      id: "x",
      ts: new Date().toISOString(),
      type: "gateway.matrix.event-received",
      payload: { roomId: "!r:x", sender: "@a:x", type: "m.room.message" },
    });
    await Bun.sleep(10);

    expect(calls).toHaveLength(0);
    handle.stop();
  });

  test("stop() unsubscribes — no further sends after stop", async () => {
    const bus = createGatewayBus();
    const { sender, calls } = makeMockSender();
    const handle = startGiteaBusConsumer({ bus, send: sender });

    handle.stop();
    publishGiteaEvent(bus, {
      delivery_id: "d2",
      repo: "jensbodal/agents-js",
      event_type: "pull_request",
      action: "opened",
      actor: "ajs-claude",
    });
    await Bun.sleep(10);

    expect(calls).toHaveLength(0);
  });
});

describe("startGiteaBusConsumer — event-type allowlist", () => {
  test("default allowlist includes pull_request, push, release, check_run", async () => {
    const bus = createGatewayBus();
    const { sender, calls } = makeMockSender();
    const handle = startGiteaBusConsumer({ bus, send: sender });

    for (const eventType of ["pull_request", "push", "release", "check_run"]) {
      publishGiteaEvent(bus, {
        delivery_id: `d-${eventType}`,
        repo: "jensbodal/agents-js",
        event_type: eventType,
        actor: "ajs-claude",
        ...(eventType === "pull_request" ? { action: "opened" } : {}),
      });
    }
    await Bun.sleep(20);

    expect(calls.length).toBe(4);
    handle.stop();
  });

  test("silently drops events outside the default allowlist (no send)", async () => {
    const bus = createGatewayBus();
    const { sender, calls } = makeMockSender();
    const handle = startGiteaBusConsumer({ bus, send: sender });

    publishGiteaEvent(bus, {
      delivery_id: "d-issue",
      repo: "jensbodal/agents-js",
      event_type: "issue_comment",
      actor: "ajs-claude",
    });
    await Bun.sleep(10);

    expect(calls).toHaveLength(0);
    handle.stop();
  });

  test("custom allowedEventTypes overrides default allowlist", async () => {
    const bus = createGatewayBus();
    const { sender, calls } = makeMockSender();
    const handle = startGiteaBusConsumer({
      bus,
      send: sender,
      allowedEventTypes: ["release"],
    });

    publishGiteaEvent(bus, {
      delivery_id: "d-pr",
      repo: "jensbodal/agents-js",
      event_type: "pull_request",
      action: "opened",
      actor: "ajs-claude",
    });
    publishGiteaEvent(bus, {
      delivery_id: "d-rel",
      repo: "jensbodal/agents-js",
      event_type: "release",
      action: "created",
      actor: "ajs-claude",
      title: "v0.6.0",
    });
    await Bun.sleep(20);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toContain("release");
    handle.stop();
  });
});

describe("formatGiteaMatrixBody — body shape per event type", () => {
  test("pull_request opened → `[gitea/<repo>] PR <action> #N by <actor>: <title> — <url>`", () => {
    const body = formatGiteaMatrixBody({
      delivery_id: "d",
      repo: "jensbodal/agents-js",
      event_type: "pull_request",
      action: "opened",
      actor: "ajs-claude",
      title: "feat: scaffold consumer",
      target_url: "https://gitea.q4m.dev/jensbodal/agents-js/pulls/42",
      commit_sha: "abc",
    });
    expect(body).toBe(
      "[gitea/jensbodal/agents-js] PR opened by ajs-claude: feat: scaffold consumer — https://gitea.q4m.dev/jensbodal/agents-js/pulls/42",
    );
  });

  test("push → `[gitea/<repo>] push by <actor>: <title> — <url>`", () => {
    const body = formatGiteaMatrixBody({
      delivery_id: "d",
      repo: "jensbodal/agents-js",
      event_type: "push",
      actor: "ajs-claude",
      title: "push to refs/heads/main",
      target_url: "https://gitea.q4m.dev/jensbodal/agents-js/compare/old...new",
      commit_sha: "newsha",
    });
    expect(body).toBe(
      "[gitea/jensbodal/agents-js] push by ajs-claude: push to refs/heads/main — https://gitea.q4m.dev/jensbodal/agents-js/compare/old...new",
    );
  });

  test("release created → `[gitea/<repo>] release <action> by <actor>: <title> — <url>`", () => {
    const body = formatGiteaMatrixBody({
      delivery_id: "d",
      repo: "jensbodal/agents-js",
      event_type: "release",
      action: "created",
      actor: "ajs-claude",
      title: "v0.6.0",
      target_url: "https://gitea.q4m.dev/jensbodal/agents-js/releases/tag/v0.6.0",
    });
    expect(body).toBe(
      "[gitea/jensbodal/agents-js] release created by ajs-claude: v0.6.0 — https://gitea.q4m.dev/jensbodal/agents-js/releases/tag/v0.6.0",
    );
  });

  test("check_run failure → `[gitea/<repo>] check_run <action> by <actor>: <title> — <url>`", () => {
    const body = formatGiteaMatrixBody({
      delivery_id: "d",
      repo: "jensbodal/agents-js",
      event_type: "check_run",
      action: "completed",
      actor: "gitea-ci",
      title: "deterministic",
      target_url: "https://gitea.q4m.dev/jensbodal/agents-js/actions/runs/123",
      commit_sha: "abc",
    });
    expect(body).toBe(
      "[gitea/jensbodal/agents-js] check_run completed by gitea-ci: deterministic — https://gitea.q4m.dev/jensbodal/agents-js/actions/runs/123",
    );
  });

  test("omits ` — <url>` when target_url missing", () => {
    const body = formatGiteaMatrixBody({
      delivery_id: "d",
      repo: "jensbodal/agents-js",
      event_type: "pull_request",
      action: "opened",
      actor: "ajs-claude",
      title: "feat: x",
    });
    expect(body).toBe("[gitea/jensbodal/agents-js] PR opened by ajs-claude: feat: x");
  });

  test("omits `<title>` when title missing (falls back to event type word)", () => {
    const body = formatGiteaMatrixBody({
      delivery_id: "d",
      repo: "jensbodal/agents-js",
      event_type: "push",
      actor: "ajs-claude",
      target_url: "https://gitea.q4m.dev/x",
    });
    expect(body).toBe("[gitea/jensbodal/agents-js] push by ajs-claude — https://gitea.q4m.dev/x");
  });
});

describe("startGiteaBusConsumer — malformed-event drop", () => {
  test("drops payload missing `repo` (no send, no throw)", async () => {
    const bus = createGatewayBus();
    const { sender, calls } = makeMockSender();
    const handle = startGiteaBusConsumer({ bus, send: sender });

    publishGiteaEvent(bus, {
      delivery_id: "d",
      event_type: "pull_request",
      actor: "ajs-claude",
      // repo missing
    });
    await Bun.sleep(10);

    expect(calls).toHaveLength(0);
    handle.stop();
  });

  test("drops payload missing `event_type` (no send, no throw)", async () => {
    const bus = createGatewayBus();
    const { sender, calls } = makeMockSender();
    const handle = startGiteaBusConsumer({ bus, send: sender });

    publishGiteaEvent(bus, {
      delivery_id: "d",
      repo: "jensbodal/agents-js",
      actor: "ajs-claude",
      // event_type missing
    });
    await Bun.sleep(10);

    expect(calls).toHaveLength(0);
    handle.stop();
  });

  test("drops payload missing `actor` (no send, no throw)", async () => {
    const bus = createGatewayBus();
    const { sender, calls } = makeMockSender();
    const handle = startGiteaBusConsumer({ bus, send: sender });

    publishGiteaEvent(bus, {
      delivery_id: "d",
      repo: "jensbodal/agents-js",
      event_type: "pull_request",
      // actor missing
    });
    await Bun.sleep(10);

    expect(calls).toHaveLength(0);
    handle.stop();
  });

  test("drops non-object payload (no send, no throw)", async () => {
    const bus = createGatewayBus();
    const { sender, calls } = makeMockSender();
    const handle = startGiteaBusConsumer({ bus, send: sender });

    bus.publish({
      id: "x",
      ts: new Date().toISOString(),
      type: GITEA_BUS_CONSUMER_TOPIC,
      payload: "not an object",
    });
    await Bun.sleep(10);

    expect(calls).toHaveLength(0);
    handle.stop();
  });
});

describe("startGiteaBusConsumer — send-failure resilience", () => {
  test("send failure does not throw out of handler (subscription stays alive)", async () => {
    const bus = createGatewayBus();
    const { sender, calls } = makeFailingSender();
    const warnings: { msg: string; data: unknown }[] = [];
    const handle = startGiteaBusConsumer({
      bus,
      send: sender,
      logger: {
        warn: (msg: string, data?: unknown) => warnings.push({ msg, data }),
        error: () => {},
        log: () => {},
      },
    });

    publishGiteaEvent(bus, {
      delivery_id: "d1",
      repo: "jensbodal/agents-js",
      event_type: "pull_request",
      action: "opened",
      actor: "ajs-claude",
      title: "feat: x",
    });
    await Bun.sleep(20);

    expect(calls).toHaveLength(1); // attempted
    expect(warnings.some((w) => w.msg.includes("send-failed"))).toBe(true);
    handle.stop();
  });

  test("send failure on first event does NOT block subsequent events", async () => {
    const bus = createGatewayBus();
    const calls: string[] = [];
    let failNext = true;
    const sender = async (args: { body: string; identity: string }): Promise<void> => {
      calls.push(args.body);
      if (failNext) {
        failNext = false;
        throw new Error("transient");
      }
    };
    const handle = startGiteaBusConsumer({
      bus,
      send: sender,
      logger: { warn: () => {}, error: () => {}, log: () => {} },
    });

    publishGiteaEvent(bus, {
      delivery_id: "d1",
      repo: "jensbodal/agents-js",
      event_type: "pull_request",
      action: "opened",
      actor: "ajs-claude",
      title: "first",
    });
    await Bun.sleep(20);
    publishGiteaEvent(bus, {
      delivery_id: "d2",
      repo: "jensbodal/agents-js",
      event_type: "pull_request",
      action: "merged",
      actor: "ajs-claude",
      title: "second",
    });
    await Bun.sleep(20);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("second");
    handle.stop();
  });
});

describe("startGiteaBusConsumer — identity injection", () => {
  test("default identity is `gitea-bot`", async () => {
    const bus = createGatewayBus();
    const { sender, calls } = makeMockSender();
    const handle = startGiteaBusConsumer({ bus, send: sender });

    publishGiteaEvent(bus, {
      delivery_id: "d",
      repo: "jensbodal/agents-js",
      event_type: "pull_request",
      action: "opened",
      actor: "ajs-claude",
      title: "x",
    });
    await Bun.sleep(10);

    expect(calls[0]?.identity).toBe("gitea-bot");
    handle.stop();
  });

  test("custom identity passed through to send", async () => {
    const bus = createGatewayBus();
    const { sender, calls } = makeMockSender();
    const handle = startGiteaBusConsumer({
      bus,
      send: sender,
      identity: "agents-js-bot",
    });

    publishGiteaEvent(bus, {
      delivery_id: "d",
      repo: "jensbodal/agents-js",
      event_type: "release",
      action: "created",
      actor: "ajs-claude",
      title: "v0.6.0",
    });
    await Bun.sleep(10);

    expect(calls[0]?.identity).toBe("agents-js-bot");
    handle.stop();
  });
});
