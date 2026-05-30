import { describe, expect, test } from "bun:test";
import { createDocsViewHandler, renderDocsViewHtml } from "../docs-view-mount.ts";

/**
 * Behavior tests for the gateway `/docs` landing view.
 *
 * The view is the only HTML the gateway emits. The load-bearing
 * invariants: it self-routes on `GET /docs` and falls through (`null`)
 * for everything else so it never shadows API routes; it links out to
 * the decided documentation hosts; and a non-GET to `/docs` is a 405
 * rather than a fall-through (so the route can't be probed with the
 * wrong method and silently 404 elsewhere).
 */

describe("renderDocsViewHtml", () => {
  test("links out to the public docs and the internal preview by default", () => {
    const html = renderDocsViewHtml();
    expect(html).toContain('href="https://agents-js.bodal.dev"');
    expect(html).toContain('href="https://agents-js.q4m.dev"');
  });

  test("declares itself an internal, non-public, noindex surface", () => {
    const html = renderDocsViewHtml();
    expect(html).toContain('content="noindex, nofollow"');
    expect(html.toLowerCase()).toContain("internal");
  });

  test("points at the live gateway surfaces on this listener", () => {
    const html = renderDocsViewHtml();
    expect(html).toContain("/.well-known/agent-card.json");
    expect(html).toContain("/events");
    expect(html).toContain("/agent");
  });

  test("honors custom doc URLs and escapes them", () => {
    const html = renderDocsViewHtml({
      publicDocsUrl: "https://example.test/docs?a=1&b=2",
      previewDocsUrl: "https://preview.test/",
    });
    // `&` must be entity-escaped inside the attribute.
    expect(html).toContain('href="https://example.test/docs?a=1&amp;b=2"');
    expect(html).toContain('href="https://preview.test/"');
    expect(html).not.toContain('href="https://agents-js.bodal.dev"');
  });
});

describe("createDocsViewHandler", () => {
  test("GET /docs returns 200 text/html", async () => {
    const handler = createDocsViewHandler();
    const res = await handler(new Request("http://gw.local/docs", { method: "GET" }));
    expect(res).not.toBeNull();
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const body = await res?.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("https://agents-js.bodal.dev");
  });

  test("non-/docs paths fall through (return null)", async () => {
    const handler = createDocsViewHandler();
    for (const path of ["/agent", "/events", "/.well-known/agent-card.json", "/", "/docs/extra"]) {
      const res = await handler(new Request(`http://gw.local${path}`, { method: "GET" }));
      expect(res).toBeNull();
    }
  });

  test("non-GET to /docs returns 405 with Allow: GET", async () => {
    const handler = createDocsViewHandler();
    const res = await handler(new Request("http://gw.local/docs", { method: "POST" }));
    expect(res?.status).toBe(405);
    expect(res?.headers.get("Allow")).toBe("GET");
  });

  test("custom path is honored; default /docs no longer matches", async () => {
    const handler = createDocsViewHandler({ path: "/gateway-docs" });
    const hit = await handler(new Request("http://gw.local/gateway-docs", { method: "GET" }));
    expect(hit?.status).toBe(200);
    const miss = await handler(new Request("http://gw.local/docs", { method: "GET" }));
    expect(miss).toBeNull();
  });
});
