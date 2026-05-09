import { describe, expect, test } from "bun:test";
import { composeAdditionalFetch } from "../main.ts";

/**
 * Behavior tests for the gateway's additionalFetch composition.
 *
 * The interesting invariant: registry sync is opt-in. When the
 * registrySyncFlag is off, `composeAdditionalFetch` must NOT route
 * `/.well-known/agents-js-registry.json` to a sync handler — the
 * request must fall through to the underlying A2A server (which 404s).
 *
 * Regex-style preflight checks on main.ts cannot prove this. We need
 * to actually invoke the chain and observe the response.
 */

const SYNC_PATH = "/.well-known/agents-js-registry.json";
const AGUI_PATH = "/agent";

describe("composeAdditionalFetch — registry sync default-off", () => {
  test("sync endpoint NOT mounted when syncEndpointHandler=null (default)", async () => {
    const syncHandlerCalled = false;
    const compose = composeAdditionalFetch({
      planeWebhookHandler: async () => null,
      aguiHandler: async () => null,
      syncEndpointHandler: null,
    });

    const response = await compose(new Request(`http://gw.local${SYNC_PATH}`, { method: "GET" }));
    // Falls through to the server's own routing (the test boundary
    // here is a `null` return; the real server then 404s).
    expect(response).toBeNull();
    expect(syncHandlerCalled).toBe(false);
  });

  test("sync endpoint IS mounted when syncEndpointHandler is provided", async () => {
    const compose = composeAdditionalFetch({
      planeWebhookHandler: async () => null,
      aguiHandler: async () => null,
      syncEndpointHandler: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === SYNC_PATH && req.method === "GET") {
          return new Response(JSON.stringify({ version: 2, records: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return null;
      },
    });

    const response = await compose(new Request(`http://gw.local${SYNC_PATH}`, { method: "GET" }));
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { version: number };
    expect(body.version).toBe(2);
  });

  test("AG-UI route runs before sync — sync handler does not shadow /agent", async () => {
    let aguiHandled = false;
    let syncHandled = false;
    const compose = composeAdditionalFetch({
      planeWebhookHandler: async () => null,
      aguiHandler: async (req) => {
        if (new URL(req.url).pathname === AGUI_PATH) {
          aguiHandled = true;
          return new Response("agui", { status: 200 });
        }
        return null;
      },
      syncEndpointHandler: async () => {
        syncHandled = true;
        return new Response("sync", { status: 200 });
      },
    });

    await compose(new Request(`http://gw.local${AGUI_PATH}`, { method: "POST" }));

    expect(aguiHandled).toBe(true);
    expect(syncHandled).toBe(false);
  });

  test("plane-webhook route runs first — preempts AG-UI and sync", async () => {
    let planeHandled = false;
    let aguiHandled = false;
    const compose = composeAdditionalFetch({
      planeWebhookHandler: async () => {
        planeHandled = true;
        return new Response("plane", { status: 200 });
      },
      aguiHandler: async () => {
        aguiHandled = true;
        return new Response("agui", { status: 200 });
      },
      syncEndpointHandler: async () => new Response("sync", { status: 200 }),
    });

    await compose(new Request(`http://gw.local/plane/webhook`, { method: "POST" }));

    expect(planeHandled).toBe(true);
    expect(aguiHandled).toBe(false);
  });
});
