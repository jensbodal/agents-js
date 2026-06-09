/**
 * Tests for the gateway root signpost (`apps/internal-gateway/gateway-root-mount.ts`).
 *
 * The gateway's `:9321/` root previously returned a bare A2A 404. A human who
 * typed the API host instead of the web-ui host hit a dead end. This handler
 * replaces that 404 with a small informational page identifying the machine API
 * and (when configured) linking the human web-ui URL — the in-app half of the
 * BL-59 hostname-footgun fix. It must NOT shadow real API routes.
 */
import { describe, expect, test } from "bun:test";
import { createGatewayRootHandler, renderGatewayRootHtml } from "../gateway-root-mount.ts";

describe("renderGatewayRootHtml", () => {
  test("identifies the agents-js API gateway with no human URL configured", () => {
    const html = renderGatewayRootHtml();
    expect(html).toContain("agents-js");
    expect(html).toContain("API");
    // No configured human URL → no broken/empty anchor pointing nowhere.
    expect(html).not.toContain('href=""');
  });

  test("links the configured human web-ui URL", () => {
    const html = renderGatewayRootHtml({ humanUrl: "https://ui.example/" });
    expect(html).toContain('href="https://ui.example/"');
  });

  test("HTML-escapes the configured human URL", () => {
    const html = renderGatewayRootHtml({ humanUrl: 'https://x/"><script>' });
    expect(html).not.toContain('"><script>');
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });
});

describe("createGatewayRootHandler", () => {
  test("answers GET / with a 200 HTML signpost", async () => {
    const handler = createGatewayRootHandler({ humanUrl: "https://ui.example/" });
    const res = await handler(new Request("http://gw.internal/"));
    expect(res).not.toBeNull();
    expect(res?.status).toBe(200);
    expect(res?.headers.get("Content-Type")).toContain("text/html");
    expect(await res?.text()).toContain("https://ui.example/");
  });

  test("returns null for non-root paths so it does not shadow API routes", async () => {
    const handler = createGatewayRootHandler();
    for (const path of ["/docs", "/jsonrpc", "/.well-known/agent-card.json", "/agent"]) {
      const res = await handler(new Request(`http://gw.internal${path}`));
      expect(res).toBeNull();
    }
  });

  test("returns 405 with Allow: GET for a non-GET root request", async () => {
    const handler = createGatewayRootHandler();
    const res = await handler(new Request("http://gw.internal/", { method: "POST" }));
    expect(res?.status).toBe(405);
    expect(res?.headers.get("Allow")).toBe("GET");
  });
});
