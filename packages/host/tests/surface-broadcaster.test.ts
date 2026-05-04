import { describe, expect, test } from "bun:test";
import type { A2uiMessage } from "@agents-js/a2ui-types";
import { createGatewaySurfaceBroadcaster } from "../src/surface-broadcaster.ts";

function makeCreateSurface(id: string): A2uiMessage {
  return {
    messageType: "CreateSurface",
    surfaceId: id,
    components: [],
    root: null,
    dataModel: {},
  } as unknown as A2uiMessage;
}

function makeUpdateComponents(id: string): A2uiMessage {
  return {
    messageType: "UpdateComponents",
    surfaceId: id,
    components: [],
  } as unknown as A2uiMessage;
}

describe("createGatewaySurfaceBroadcaster", () => {
  test("forwards messages to the attached broadcaster in order", () => {
    const broadcaster = createGatewaySurfaceBroadcaster();
    const received: A2uiMessage[] = [];
    broadcaster.attach((msg) => {
      received.push(msg);
    });

    const messages = [makeCreateSurface("s1"), makeUpdateComponents("s1"), makeCreateSurface("s2")];
    for (const msg of messages) {
      broadcaster.handleSurfaceMessage(msg);
    }

    expect(received).toEqual(messages);
  });

  test("handleSurfaceMessage without attach invokes onUnattached and drops the message", () => {
    const dropped: A2uiMessage[] = [];
    const broadcaster = createGatewaySurfaceBroadcaster({
      onUnattached: (msg) => {
        dropped.push(msg);
      },
    });

    const msg = makeCreateSurface("early");
    broadcaster.handleSurfaceMessage(msg);

    expect(dropped).toEqual([msg]);
  });

  test("re-attach replaces the previous broadcaster for subsequent messages", () => {
    const broadcaster = createGatewaySurfaceBroadcaster();
    const first: A2uiMessage[] = [];
    const second: A2uiMessage[] = [];

    broadcaster.attach((msg) => {
      first.push(msg);
    });

    const before = makeCreateSurface("before");
    broadcaster.handleSurfaceMessage(before);

    broadcaster.attach((msg) => {
      second.push(msg);
    });

    const after = makeUpdateComponents("after");
    broadcaster.handleSurfaceMessage(after);

    expect(first).toEqual([before]);
    expect(second).toEqual([after]);
  });

  test("handleSurfaceClosed does not invoke the broadcaster", () => {
    const broadcaster = createGatewaySurfaceBroadcaster();
    const received: A2uiMessage[] = [];
    broadcaster.attach((msg) => {
      received.push(msg);
    });

    broadcaster.handleSurfaceClosed?.("s1");

    expect(received).toEqual([]);
  });
});
