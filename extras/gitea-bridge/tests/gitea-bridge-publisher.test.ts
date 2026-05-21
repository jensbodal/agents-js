import { describe, expect, test } from "bun:test";
import { createGatewayBus, type GatewayBusEvent } from "@agents-js/host";
import {
  buildGiteaBusEvent,
  GITEA_BRIDGE_EVENT_TOPIC,
  GITEA_SOURCE_PRINCIPAL_KIND,
  type GiteaBridgeEventInput,
  publishGiteaEventToBus,
} from "../src/index.ts";

// `@agents-js/gitea-bridge` is the Gitea-flavored adapter over the
// generic bridge primitive in `@agents-js/host`. agents-js core knows
// nothing about Gitea; this package adds the canonical topic, actor
// → source-principal mapping, and payload shape that the in-process
// receiver in `packages/host/src/gitea-webhook.ts` produces.

const SAMPLE_GITEA_EVENT: GiteaBridgeEventInput = {
  delivery_id: "deliv-abc-123",
  repo: "jensbodal/agents-js",
  event_type: "pull_request",
  action: "opened",
  actor: "ajs-claude",
  target_url: "https://gitea.q4m.dev/jensbodal/agents-js/pulls/42",
  commit_sha: "abc123def456",
  title: "feat(gitea-bridge): scaffold gitea webhook bridge package",
};

describe("buildGiteaBusEvent", () => {
  test("emits the canonical `gateway.gitea.event-received` topic", () => {
    const envelope = buildGiteaBusEvent({ giteaEvent: SAMPLE_GITEA_EVENT });
    expect(envelope.type).toBe(GITEA_BRIDGE_EVENT_TOPIC);
    expect(envelope.type).toBe("gateway.gitea.event-received");
  });

  test("preserves the Gitea event verbatim as the payload", () => {
    const envelope = buildGiteaBusEvent({ giteaEvent: SAMPLE_GITEA_EVENT });
    expect(envelope.payload).toEqual(SAMPLE_GITEA_EVENT);
    expect(envelope.payload.delivery_id).toBe("deliv-abc-123");
    expect(envelope.payload.repo).toBe("jensbodal/agents-js");
    expect(envelope.payload.event_type).toBe("pull_request");
    expect(envelope.payload.action).toBe("opened");
    expect(envelope.payload.actor).toBe("ajs-claude");
    expect(envelope.payload.target_url).toBe("https://gitea.q4m.dev/jensbodal/agents-js/pulls/42");
    expect(envelope.payload.commit_sha).toBe("abc123def456");
  });

  test("defaults source-principal to `{ kind: 'webhook', id: 'gitea:<repo>:<actor>' }`", () => {
    const envelope = buildGiteaBusEvent({ giteaEvent: SAMPLE_GITEA_EVENT });
    expect(envelope.sourcePrincipal?.kind).toBe(GITEA_SOURCE_PRINCIPAL_KIND);
    expect(envelope.sourcePrincipal?.kind).toBe("webhook");
    expect(envelope.sourcePrincipal?.id).toBe("gitea:jensbodal/agents-js:ajs-claude");
  });

  test("respects a caller-supplied source-principal override", () => {
    const envelope = buildGiteaBusEvent({
      giteaEvent: SAMPLE_GITEA_EVENT,
      sourcePrincipal: { kind: "bridge", id: "gitea-webhook-receiver" },
    });
    expect(envelope.sourcePrincipal?.kind).toBe("bridge");
    expect(envelope.sourcePrincipal?.id).toBe("gitea-webhook-receiver");
  });

  test("propagates correlationId when supplied", () => {
    const envelope = buildGiteaBusEvent({
      giteaEvent: SAMPLE_GITEA_EVENT,
      correlationId: "gitea-corr-1",
    });
    expect(envelope.correlationId).toBe("gitea-corr-1");
  });

  test("omits correlationId when not supplied", () => {
    const envelope = buildGiteaBusEvent({ giteaEvent: SAMPLE_GITEA_EVENT });
    expect(envelope.correlationId).toBeUndefined();
  });

  test("each call produces a unique envelope id", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const envelope = buildGiteaBusEvent({ giteaEvent: SAMPLE_GITEA_EVENT });
      ids.add(envelope.id);
    }
    expect(ids.size).toBe(50);
  });

  test("stamps `ts` as an ISO-8601 string", () => {
    const envelope = buildGiteaBusEvent({ giteaEvent: SAMPLE_GITEA_EVENT });
    expect(envelope.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("returned envelope is typed against GiteaBridgeEventInput", () => {
    const envelope: GatewayBusEvent<GiteaBridgeEventInput> = buildGiteaBusEvent({
      giteaEvent: SAMPLE_GITEA_EVENT,
    });
    expect(envelope.payload.repo).toBe("jensbodal/agents-js");
  });

  test("accepts partial Gitea events (only delivery_id + repo + event_type + actor required)", () => {
    const partial: GiteaBridgeEventInput = {
      delivery_id: "deliv-xyz-789",
      repo: "jensbodal/agents-js",
      event_type: "push",
      actor: "jensbodal",
    };
    const envelope = buildGiteaBusEvent({ giteaEvent: partial });
    expect(envelope.payload).toEqual(partial);
    expect(envelope.payload.action).toBeUndefined();
    expect(envelope.payload.target_url).toBeUndefined();
    expect(envelope.payload.commit_sha).toBeUndefined();
    expect(envelope.payload.title).toBeUndefined();
  });

  test("default source-principal id encodes both repo + actor for filterability", () => {
    const envelope = buildGiteaBusEvent({
      giteaEvent: {
        delivery_id: "d",
        repo: "break-even-llc/dot-matrix",
        event_type: "release",
        actor: "cognee-codex",
      },
    });
    // Subscribers can filter on `sourcePrincipal.id` substring matches
    // without parsing the payload. Encoded as gitea:<repo>:<actor>.
    expect(envelope.sourcePrincipal?.id).toBe("gitea:break-even-llc/dot-matrix:cognee-codex");
  });
});

describe("publishGiteaEventToBus", () => {
  test("builds and publishes the envelope on the supplied bus", () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => received.push(event));

    const envelope = publishGiteaEventToBus({
      bus,
      giteaEvent: SAMPLE_GITEA_EVENT,
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe(envelope.id);
    expect(received[0]?.type).toBe(GITEA_BRIDGE_EVENT_TOPIC);
    expect(received[0]?.sourcePrincipal?.kind).toBe("webhook");
  });

  test("each call produces a distinct envelope id even with identical input", () => {
    const bus = createGatewayBus();
    const a = publishGiteaEventToBus({ bus, giteaEvent: SAMPLE_GITEA_EVENT });
    const b = publishGiteaEventToBus({ bus, giteaEvent: SAMPLE_GITEA_EVENT });
    expect(a.id).not.toBe(b.id);
  });

  test("respects a caller-supplied source-principal override", () => {
    const bus = createGatewayBus();
    const envelope = publishGiteaEventToBus({
      bus,
      giteaEvent: SAMPLE_GITEA_EVENT,
      sourcePrincipal: { kind: "bridge", id: "gitea-webhook-receiver" },
    });
    expect(envelope.sourcePrincipal?.kind).toBe("bridge");
  });
});
