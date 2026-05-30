import { describe, expect, test } from "bun:test";
import { createDocsViewHandler } from "../docs-view-mount.ts";
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
      busSubscribeHandler: async () => null,
      busPublishHandler: async () => null,
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
      busSubscribeHandler: async () => null,
      busPublishHandler: async () => null,
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
      busSubscribeHandler: async () => null,
      busPublishHandler: async () => null,
      syncEndpointHandler: async () => {
        syncHandled = true;
        return new Response("sync", { status: 200 });
      },
    });

    await compose(new Request(`http://gw.local${AGUI_PATH}`, { method: "POST" }));

    expect(aguiHandled).toBe(true);
    expect(syncHandled).toBe(false);
  });

  test("bus subscribe handler runs before other routes — preempts AG-UI", async () => {
    let busSubHandled = false;
    let aguiHandled = false;
    const compose = composeAdditionalFetch({
      planeWebhookHandler: async () => null,
      aguiHandler: async () => {
        aguiHandled = true;
        return new Response("agui", { status: 200 });
      },
      busSubscribeHandler: async (req) => {
        if (new URL(req.url).pathname === "/events") {
          busSubHandled = true;
          return new Response("sse", { status: 200 });
        }
        return null;
      },
      busPublishHandler: async () => null,
      syncEndpointHandler: null,
    });

    await compose(new Request("http://gw.local/events", { method: "GET" }));

    expect(busSubHandled).toBe(true);
    expect(aguiHandled).toBe(false);
  });

  test("bus publish handler runs before plane-webhook — admin path takes priority", async () => {
    let busPubHandled = false;
    let planeHandled = false;
    const compose = composeAdditionalFetch({
      planeWebhookHandler: async () => {
        planeHandled = true;
        return new Response("plane", { status: 200 });
      },
      aguiHandler: async () => null,
      busSubscribeHandler: async () => null,
      busPublishHandler: async (req) => {
        if (new URL(req.url).pathname === "/admin/publish") {
          busPubHandled = true;
          return new Response('{"accepted":true}', { status: 200 });
        }
        return null;
      },
      syncEndpointHandler: null,
    });

    await compose(new Request("http://gw.local/admin/publish", { method: "POST" }));

    expect(busPubHandled).toBe(true);
    expect(planeHandled).toBe(false);
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
      busSubscribeHandler: async () => null,
      busPublishHandler: async () => null,
      syncEndpointHandler: async () => new Response("sync", { status: 200 }),
    });

    await compose(new Request(`http://gw.local/plane/webhook`, { method: "POST" }));

    expect(planeHandled).toBe(true);
    expect(aguiHandled).toBe(false);
  });

  /**
   * WHAT: When `giteaWebhookHandler` is absent (or `null`), the chain
   *       behaves exactly as before — `/webhooks/gitea` falls through
   *       and AG-UI's `/agent` route still wins for its own path.
   * WHY: The bridge is opt-in via env. Existing call sites that don't
   *       supply the field (every test in this file, plus any older
   *       composeAdditionalFetch caller) must keep working without
   *       opting into the new route surface.
   */
  test("gitea-webhook route NOT mounted when handler is absent (default)", async () => {
    let aguiHandled = false;
    const compose = composeAdditionalFetch({
      planeWebhookHandler: async () => null,
      aguiHandler: async (req) => {
        if (new URL(req.url).pathname === AGUI_PATH) {
          aguiHandled = true;
          return new Response("agui", { status: 200 });
        }
        return null;
      },
      busSubscribeHandler: async () => null,
      busPublishHandler: async () => null,
      syncEndpointHandler: null,
      // giteaWebhookHandler intentionally omitted
    });

    const giteaRes = await compose(
      new Request("http://gw.local/webhooks/gitea", { method: "POST" }),
    );
    expect(giteaRes).toBeNull();

    const aguiRes = await compose(new Request(`http://gw.local${AGUI_PATH}`, { method: "POST" }));
    expect(aguiRes?.status).toBe(200);
    expect(aguiHandled).toBe(true);
  });

  /**
   * WHAT: When `giteaWebhookHandler` is provided, it handles its own
   *       path and falls through (returns null) for unrelated paths so
   *       AG-UI / sync continue to work.
   * WHY: The receiver self-routes on `/webhooks/gitea` (returns null
   *       for other paths); the chain composition must respect that
   *       null-passthrough contract — otherwise a returned 405 from
   *       the gitea handler on `/agent` would shadow AG-UI.
   */
  test("gitea-webhook route IS mounted when handler provided; non-matching paths pass through", async () => {
    let giteaHandled = false;
    let aguiHandled = false;
    const compose = composeAdditionalFetch({
      planeWebhookHandler: async () => null,
      aguiHandler: async (req) => {
        if (new URL(req.url).pathname === AGUI_PATH) {
          aguiHandled = true;
          return new Response("agui", { status: 200 });
        }
        return null;
      },
      busSubscribeHandler: async () => null,
      busPublishHandler: async () => null,
      syncEndpointHandler: null,
      giteaWebhookHandler: async (req) => {
        if (new URL(req.url).pathname === "/webhooks/gitea") {
          giteaHandled = true;
          return new Response('{"accepted":true}', { status: 200 });
        }
        return null;
      },
    });

    const giteaRes = await compose(
      new Request("http://gw.local/webhooks/gitea", { method: "POST" }),
    );
    expect(giteaRes?.status).toBe(200);
    expect(giteaHandled).toBe(true);
    expect(aguiHandled).toBe(false);

    const aguiRes = await compose(new Request(`http://gw.local${AGUI_PATH}`, { method: "POST" }));
    expect(aguiRes?.status).toBe(200);
    expect(aguiHandled).toBe(true);
  });

  /**
   * WHAT: When `docsViewHandler` is absent, the chain behaves exactly as
   *       before — `/docs` falls through and AG-UI's `/agent` still wins.
   * WHY: Optional-field back-compat. Every pre-existing call site (these
   *       tests included) omits the field and must keep working.
   */
  test("docs-view route NOT mounted when handler is absent (default)", async () => {
    let aguiHandled = false;
    const compose = composeAdditionalFetch({
      planeWebhookHandler: async () => null,
      aguiHandler: async (req) => {
        if (new URL(req.url).pathname === AGUI_PATH) {
          aguiHandled = true;
          return new Response("agui", { status: 200 });
        }
        return null;
      },
      busSubscribeHandler: async () => null,
      busPublishHandler: async () => null,
      syncEndpointHandler: null,
      // docsViewHandler intentionally omitted
    });

    const docsRes = await compose(new Request("http://gw.local/docs", { method: "GET" }));
    expect(docsRes).toBeNull();

    const aguiRes = await compose(new Request(`http://gw.local${AGUI_PATH}`, { method: "POST" }));
    expect(aguiRes?.status).toBe(200);
    expect(aguiHandled).toBe(true);
  });

  /**
   * WHAT: When `docsViewHandler` is provided, it handles `/docs` and
   *       falls through for unrelated paths so AG-UI continues to work.
   * WHY: The handler self-routes (returns null for other paths); the
   *       chain must respect that null-passthrough contract so the docs
   *       view never shadows `/agent` or the API routes.
   */
  test("docs-view route IS mounted when handler provided; non-matching paths pass through", async () => {
    let docsHandled = false;
    let aguiHandled = false;
    const compose = composeAdditionalFetch({
      planeWebhookHandler: async () => null,
      aguiHandler: async (req) => {
        if (new URL(req.url).pathname === AGUI_PATH) {
          aguiHandled = true;
          return new Response("agui", { status: 200 });
        }
        return null;
      },
      busSubscribeHandler: async () => null,
      busPublishHandler: async () => null,
      syncEndpointHandler: null,
      docsViewHandler: async (req) => {
        if (new URL(req.url).pathname === "/docs" && req.method === "GET") {
          docsHandled = true;
          return new Response("<!doctype html>", {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return null;
      },
    });

    const docsRes = await compose(new Request("http://gw.local/docs", { method: "GET" }));
    expect(docsRes?.status).toBe(200);
    expect(docsHandled).toBe(true);
    expect(aguiHandled).toBe(false);

    const aguiRes = await compose(new Request(`http://gw.local${AGUI_PATH}`, { method: "POST" }));
    expect(aguiRes?.status).toBe(200);
    expect(aguiHandled).toBe(true);
  });

  /**
   * WHAT: The REAL `createDocsViewHandler()` — the exact construction
   *       `setupServer` performs — composed into the chain serves
   *       `GET /docs` as 200 HTML and falls through for `/agent`.
   * WHY: The other docs-view test above uses a mock handler, which only
   *       proves the chain's null-passthrough plumbing. This test proves
   *       the production handler itself works inside the production
   *       composition, so the wiring `setupServer` relies on is observed
   *       end-to-end through the chain (no ACP binary / full boot needed,
   *       matching this suite's convention).
   */
  test("real createDocsViewHandler composed in the chain serves GET /docs as HTML", async () => {
    let aguiHandled = false;
    const compose = composeAdditionalFetch({
      planeWebhookHandler: async () => null,
      aguiHandler: async (req) => {
        if (new URL(req.url).pathname === AGUI_PATH) {
          aguiHandled = true;
          return new Response("agui", { status: 200 });
        }
        return null;
      },
      busSubscribeHandler: async () => null,
      busPublishHandler: async () => null,
      syncEndpointHandler: null,
      docsViewHandler: createDocsViewHandler(),
    });

    const docsRes = await compose(new Request("http://gw.local/docs", { method: "GET" }));
    expect(docsRes?.status).toBe(200);
    expect(docsRes?.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const body = await docsRes?.text();
    expect(body).toContain("https://agents-js.bodal.dev");
    expect(body).toContain("https://agents-js.q4m.dev");

    // Real handler self-routes — it must not shadow the AG-UI route.
    const aguiRes = await compose(new Request(`http://gw.local${AGUI_PATH}`, { method: "POST" }));
    expect(aguiRes?.status).toBe(200);
    expect(aguiHandled).toBe(true);
  });
});
