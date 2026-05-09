import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { A2uiClientAction, A2uiMessage } from "@agents-js/a2ui-types";
import { ACP_CATALOG_ID } from "@agents-js/a2ui-types";
import { configureLogging, Logger, resetLogging } from "@agents-js/acp-host";
import type { HostSurfaceAdapter } from "../../src/acp-host/host-surface-adapter.ts";
import { SurfaceSession } from "../../src/acp-host/surface-session.ts";

function textNode(id: string, text: string): Record<string, unknown> {
  return { component: "Text", id, text };
}

function createFakeAdapter(): HostSurfaceAdapter & {
  messages: A2uiMessage[];
  closedIds: string[];
} {
  const messages: A2uiMessage[] = [];
  const closedIds: string[] = [];
  return {
    messages,
    closedIds,
    async handleSurfaceMessage(message) {
      messages.push(message);
    },
    async handleSurfaceClosed(surfaceId) {
      closedIds.push(surfaceId);
    },
  };
}

describe("SurfaceSession", () => {
  let log: Logger;

  beforeEach(() => {
    configureLogging({ minLevel: "silent" });
    log = new Logger("debug");
  });

  afterEach(() => {
    resetLogging();
  });

  test("applies CreateSurface -> UpdateComponents -> UpdateDataModel -> DeleteSurface in order", async () => {
    const adapter = createFakeAdapter();
    const session = new SurfaceSession({ adapter, log });

    const create: A2uiMessage = {
      version: "v0.9",
      createSurface: { surfaceId: "s1", catalogId: ACP_CATALOG_ID },
    };
    const update: A2uiMessage = {
      version: "v0.9",
      updateComponents: { surfaceId: "s1", components: [textNode("root", "hello")] },
    };
    const data: A2uiMessage = {
      version: "v0.9",
      updateDataModel: { surfaceId: "s1", path: "count", value: 3 },
    };
    const del: A2uiMessage = {
      version: "v0.9",
      deleteSurface: { surfaceId: "s1" },
    };

    await session.apply(create);
    expect(session.surfaceIds.has("s1")).toBe(true);

    await session.apply(update);
    await session.apply(data);
    await session.apply(del);

    expect(session.surfaceIds.has("s1")).toBe(false);
    expect(adapter.messages).toEqual([create, update, data, del]);
  });

  test("close() notifies adapter for still-open surfaces", async () => {
    const adapter = createFakeAdapter();
    const session = new SurfaceSession({ adapter, log });

    await session.apply({
      version: "v0.9",
      createSurface: { surfaceId: "a", catalogId: ACP_CATALOG_ID },
    });
    await session.apply({
      version: "v0.9",
      createSurface: { surfaceId: "b", catalogId: ACP_CATALOG_ID },
    });

    await session.close();

    expect(adapter.closedIds.sort()).toEqual(["a", "b"]);
  });

  test("close() is idempotent", async () => {
    const adapter = createFakeAdapter();
    const session = new SurfaceSession({ adapter, log });

    await session.apply({
      version: "v0.9",
      createSurface: { surfaceId: "x", catalogId: ACP_CATALOG_ID },
    });

    await session.close();
    await session.close();

    expect(adapter.closedIds).toEqual(["x"]);
  });

  test("close() skips handleSurfaceClosed for agent-deleted surfaces", async () => {
    const adapter = createFakeAdapter();
    const session = new SurfaceSession({ adapter, log });

    await session.apply({
      version: "v0.9",
      createSurface: { surfaceId: "keep", catalogId: ACP_CATALOG_ID },
    });
    await session.apply({
      version: "v0.9",
      createSurface: { surfaceId: "drop", catalogId: ACP_CATALOG_ID },
    });
    await session.apply({
      version: "v0.9",
      deleteSurface: { surfaceId: "drop" },
    });

    await session.close();

    expect(adapter.closedIds).toEqual(["keep"]);
  });

  test("apply() after close() is a no-op", async () => {
    const adapter = createFakeAdapter();
    const session = new SurfaceSession({ adapter, log });

    await session.close();
    await session.apply({
      version: "v0.9",
      createSurface: { surfaceId: "late", catalogId: ACP_CATALOG_ID },
    });

    expect(adapter.messages).toEqual([]);
  });

  test("adapter errors are swallowed so the session keeps running", async () => {
    let callCount = 0;
    const received: A2uiMessage[] = [];
    const adapter: HostSurfaceAdapter = {
      async handleSurfaceMessage(message) {
        callCount++;
        if (callCount === 1) {
          throw new Error("first message boom");
        }
        received.push(message);
      },
    };
    const session = new SurfaceSession({ adapter, log });

    await session.apply({
      version: "v0.9",
      createSurface: { surfaceId: "s", catalogId: ACP_CATALOG_ID },
    });
    await session.apply({
      version: "v0.9",
      updateComponents: { surfaceId: "s", components: [textNode("root", "ok")] },
    });

    expect(callCount).toBe(2);
    expect(received).toHaveLength(1);
  });

  type TestSurface = {
    dispatchAction: (payload: unknown, sourceComponentId: string) => Promise<void>;
  };
  type SessionInternals = {
    processor: { model: { surfacesMap: ReadonlyMap<string, TestSurface> } };
  };

  function getTestSurface(session: SurfaceSession, surfaceId: string): TestSurface | undefined {
    return (session as unknown as SessionInternals).processor.model.surfacesMap.get(surfaceId);
  }

  async function dispatchTestAction(
    session: SurfaceSession,
    surfaceId: string,
    name = "click",
    context: Record<string, unknown> = { value: 1 },
    sourceComponentId = "btn-1",
  ): Promise<void> {
    const surface = getTestSurface(session, surfaceId);
    if (!surface) throw new Error(`surface ${surfaceId} not found`);
    await surface.dispatchAction({ event: { name, context } }, sourceComponentId);
  }

  test("custom actionHandler fires when an upstream action dispatches", async () => {
    const adapter = createFakeAdapter();
    const actionHandler = mock((_action: A2uiClientAction) => {});
    const session = new SurfaceSession({ adapter, log, actionHandler });

    await session.apply({
      version: "v0.9",
      createSurface: { surfaceId: "s1", catalogId: ACP_CATALOG_ID },
    });
    await dispatchTestAction(session, "s1", "click", { value: 42 });

    expect(actionHandler).toHaveBeenCalledTimes(1);
    const received = actionHandler.mock.calls[0]?.[0];
    expect(received?.surfaceId).toBe("s1");
    expect(received?.name).toBe("click");
    expect(received?.sourceComponentId).toBe("btn-1");
    expect(received?.context).toEqual({ value: 42 });
  });

  test("default handler emits surface_event via emitSurfaceEvent when actionHandler absent", async () => {
    const adapter = createFakeAdapter();
    const emitted: Array<{ surfaceId: string; event: unknown }> = [];
    const emitSurfaceEvent = (surfaceId: string, event: unknown) => {
      emitted.push({ surfaceId, event });
    };
    const session = new SurfaceSession({ adapter, log, emitSurfaceEvent });

    await session.apply({
      version: "v0.9",
      createSurface: { surfaceId: "s1", catalogId: ACP_CATALOG_ID },
    });
    await dispatchTestAction(session, "s1", "submit", { text: "hi" });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.surfaceId).toBe("s1");
    const action = emitted[0]?.event as A2uiClientAction;
    expect(action.name).toBe("submit");
    expect(action.surfaceId).toBe("s1");
    expect(action.context).toEqual({ text: "hi" });
  });

  test("explicit actionHandler replaces default emitSurfaceEvent wiring", async () => {
    const adapter = createFakeAdapter();
    const emitSurfaceEvent = mock((_surfaceId: string, _event: unknown) => {});
    const actionHandler = mock((_action: A2uiClientAction) => {});
    const session = new SurfaceSession({
      adapter,
      log,
      emitSurfaceEvent,
      actionHandler,
    });

    await session.apply({
      version: "v0.9",
      createSurface: { surfaceId: "s1", catalogId: ACP_CATALOG_ID },
    });
    await dispatchTestAction(session, "s1");

    expect(actionHandler).toHaveBeenCalledTimes(1);
    expect(emitSurfaceEvent).not.toHaveBeenCalled();
  });

  test("emitActionsAsSurfaceEvents: false suppresses default even when emitSurfaceEvent provided", async () => {
    const adapter = createFakeAdapter();
    const emitSurfaceEvent = mock((_surfaceId: string, _event: unknown) => {});
    const session = new SurfaceSession({
      adapter,
      log,
      emitSurfaceEvent,
      emitActionsAsSurfaceEvents: false,
    });

    await session.apply({
      version: "v0.9",
      createSurface: { surfaceId: "s1", catalogId: ACP_CATALOG_ID },
    });
    await dispatchTestAction(session, "s1");

    expect(emitSurfaceEvent).not.toHaveBeenCalled();
  });

  test("default handler is a no-op after close()", async () => {
    const adapter = createFakeAdapter();
    const emitSurfaceEvent = mock((_surfaceId: string, _event: unknown) => {});
    const session = new SurfaceSession({ adapter, log, emitSurfaceEvent });

    await session.apply({
      version: "v0.9",
      createSurface: { surfaceId: "s1", catalogId: ACP_CATALOG_ID },
    });
    const surface = getTestSurface(session, "s1");
    expect(surface).toBeDefined();

    await session.close();
    await surface?.dispatchAction({ event: { name: "click", context: {} } }, "btn");

    expect(emitSurfaceEvent).not.toHaveBeenCalled();
  });

  test("adapter without handleSurfaceClosed still closes cleanly", async () => {
    const messages: A2uiMessage[] = [];
    const adapter: HostSurfaceAdapter = {
      handleSurfaceMessage(message) {
        messages.push(message);
      },
    };
    const session = new SurfaceSession({ adapter, log });

    await session.apply({
      version: "v0.9",
      createSurface: { surfaceId: "s", catalogId: ACP_CATALOG_ID },
    });

    await session.close();
    expect(messages).toHaveLength(1);
  });
});
