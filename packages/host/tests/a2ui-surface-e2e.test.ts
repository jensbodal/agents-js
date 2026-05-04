import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AGUITransport } from "@agents-js/a2a-client";
import { type A2uiMessage, ACP_CATALOG_ID } from "@agents-js/a2ui-types";
import { EventType } from "@agents-js/agui-types";
import { validateA2uiMessage, validateAguiEvent } from "@agents-js/validation";
import { createAguiFetchHandler } from "../src/agui-endpoint.ts";
import {
  buildRunAgentInput,
  createFakeHostController,
  type FakeHostController,
} from "./fake-host-controller.ts";

/**
 * Wave 5 fan-in E2E — proves the A2UI surface-event round trip across
 * the gateway boundary.
 *
 *   Track B's translator: surface_event ACPSessionEvent
 *       → AG-UI CUSTOM frame (name = "agents-js.a2ui.surface_event")
 *       → Track A's AGUITransport client receives it from the SSE stream
 *
 * Agent→Host direction (A2UI messages arriving via ACP) is covered by
 * Track A's host-surface-adapter.test.ts. This file exercises the
 * gateway-boundary side: a surface_event driven by the host relays out
 * to an AG-UI client as a CUSTOM frame, with the full payload intact.
 *
 * Also asserts the spec validator accepts each CreateSurface/UpdateComponents
 * etc. example — proving the sample A2UI messages we'd push to the adapter
 * in real use are spec-conformant.
 */

interface ServerHandle {
  baseUrl: string;
  stop: () => void;
  fake: FakeHostController;
}

function startGateway(): ServerHandle {
  const fake = createFakeHostController();
  const handler = createAguiFetchHandler({ controller: fake.controller });
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const response = await handler(req);
      return response ?? new Response("not found", { status: 404 });
    },
  });
  return {
    baseUrl: `http://${server.hostname}:${server.port}`,
    stop: () => server.stop(true),
    fake,
  };
}

async function collect(events: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("Wave 5 fan-in — A2UI surface_event round-trip across gateway", () => {
  let gateway: ServerHandle;

  beforeEach(() => {
    gateway = startGateway();
  });

  afterEach(() => {
    gateway.stop();
  });

  test("surface_event flows through /agent SSE as a CUSTOM frame with opaque payload", async () => {
    const surfacePayload = { kind: "buttonClick", elementId: "submit-1" };
    gateway.fake.setOnSendPrompt(async () => {
      queueMicrotask(() => {
        gateway.fake.emit({
          type: "surface_event",
          surfaceId: "surf-42",
          event: surfacePayload,
        });
        gateway.fake.emit({ type: "turn_completed", stopReason: "end_turn" });
      });
    });

    const transport = new AGUITransport();
    const target = await transport.resolveTarget({ url: gateway.baseUrl });
    const run = transport.runAgent(target, buildRunAgentInput("trigger surface"));
    const events = (await collect(run.events)) as Array<{
      type: string;
      name?: string;
      value?: { surfaceId?: string; event?: unknown };
    }>;

    for (const event of events) {
      expect(validateAguiEvent(event).valid).toBe(true);
    }

    const custom = events.find(
      (e) => e.type === EventType.CUSTOM && e.name === "agents-js.a2ui.surface_event",
    );
    expect(custom).toBeDefined();
    expect(custom?.value?.surfaceId).toBe("surf-42");
    expect(custom?.value?.event).toEqual(surfacePayload);
  });

  test("multiple surface_events preserve order and opaque payloads", async () => {
    const payloads = [
      { kind: "focus", elementId: "input-1" },
      { kind: "change", elementId: "input-1", value: "hello" },
      { kind: "submit", elementId: "form-main" },
    ];
    gateway.fake.setOnSendPrompt(async () => {
      queueMicrotask(() => {
        for (const payload of payloads) {
          gateway.fake.emit({
            type: "surface_event",
            surfaceId: "surf-ordered",
            event: payload,
          });
        }
        gateway.fake.emit({ type: "turn_completed", stopReason: "end_turn" });
      });
    });

    const transport = new AGUITransport();
    const target = await transport.resolveTarget({ url: gateway.baseUrl });
    const run = transport.runAgent(target, buildRunAgentInput("multi-event"));
    const events = (await collect(run.events)) as Array<{
      type: string;
      name?: string;
      value?: { event?: unknown };
    }>;

    const customs = events.filter(
      (e) => e.type === EventType.CUSTOM && e.name === "agents-js.a2ui.surface_event",
    );
    expect(customs).toHaveLength(payloads.length);
    for (let i = 0; i < payloads.length; i += 1) {
      expect(customs[i]?.value?.event).toEqual(payloads[i]);
    }
  });
});

describe("Wave 5 fan-in — A2UI message spec conformance", () => {
  /**
   * The four A2UI lifecycle message shapes that agents emit via ACP
   * `_meta.a2ui_message`. Each must pass `validateA2uiMessage` so that
   * host adapters receive them safely. This guards the shared contract
   * documented in Track A's handshake without requiring the full ACP
   * agent stack to fire.
   */
  const samples: A2uiMessage[] = [
    {
      version: "v0.9",
      createSurface: {
        surfaceId: "s-e2e",
        catalogId: ACP_CATALOG_ID,
      },
    } as A2uiMessage,
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: "s-e2e",
        components: [
          {
            component: "AcpMessage",
            id: "m-1",
            role: "assistant",
            text: "hello",
          },
        ],
      },
    } as A2uiMessage,
    {
      version: "v0.9",
      updateDataModel: {
        surfaceId: "s-e2e",
        path: "/inputValue",
        value: "typed text",
      },
    } as A2uiMessage,
    {
      version: "v0.9",
      deleteSurface: { surfaceId: "s-e2e" },
    } as A2uiMessage,
  ];

  test("CreateSurface, UpdateComponents, UpdateDataModel, DeleteSurface all validate", () => {
    for (const message of samples) {
      const result = validateA2uiMessage(message);
      expect(result.valid).toBe(true);
    }
  });
});
