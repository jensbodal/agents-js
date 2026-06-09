/**
 * Gateway root signpost (`GET /`).
 *
 * The internal gateway is a machine API: it serves `/jsonrpc`, `/.well-known/*`,
 * `/agent`, `/docs`, and the bus endpoints. Its root (`/`) previously fell
 * through to the A2A default `404`. A human who typed the API host instead of
 * the web-ui host therefore hit a bare dead end (the "two hostnames" footgun:
 * `agents-gateway.q4m.dev` is the API, the web UI lives at a separate human
 * edge). This handler replaces that 404 with a small framework-free page that
 * (a) identifies the host as the machine API and (b) — when a human web-ui URL
 * is configured — links it.
 *
 * This is the IN-APP half of the footgun fix; the complete fix is the edge
 * alias/redirect (operator/deploy lane, tracked as BL-59). It self-routes on
 * `GET /` and returns `null` for every other path so it composes in the
 * `additionalFetch` chain WITHOUT shadowing API routes — it is the last
 * informational fallback, not a router.
 *
 * The human web-ui URL is deployment-specific (it names the deploy's human
 * edge), so it is INJECTED — there is no hardcoded host default here. Unset =>
 * the page identifies the API without a link. Mirrors `docs-view-mount.ts`.
 */

const DEFAULT_ROOT_PATH = "/";

const HTTP_OK = 200;
const HTTP_METHOD_NOT_ALLOWED = 405;

export interface GatewayRootConfig {
  /** Path this handler answers on. Defaults to `/`. */
  path?: string;
  /**
   * Human-facing web-ui URL to link from the signpost. Deployment-specific —
   * injected (typically from `AGENTS_GATEWAY_HUMAN_URL` at the composition
   * root), never hardcoded. When omitted, the page identifies the API but
   * links nothing.
   */
  humanUrl?: string;
}

/**
 * Escape a string for safe interpolation into HTML. The URL is
 * operator-configured (not request-derived), but escaping keeps the template
 * robust if config ever flows from a less trusted source. Mirrors
 * `docs-view-mount.ts`.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render the root signpost page. Exported so tests can assert on the markup
 * without constructing a `Request`.
 */
export function renderGatewayRootHtml(config: GatewayRootConfig = {}): string {
  const humanLink =
    config.humanUrl !== undefined
      ? `
    <h2>Looking for the web UI?</h2>
    <p><a href="${escapeHtml(config.humanUrl)}">${escapeHtml(config.humanUrl)}</a> — the human-facing interface.</p>`
      : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>agents-js gateway API</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        line-height: 1.55;
        max-width: 42rem;
        margin: 4rem auto;
        padding: 0 1.25rem;
      }
      h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
      .lede { opacity: 0.75; margin-top: 0; }
      ul { padding-left: 1.1rem; }
      li { margin: 0.35rem 0; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
      .note {
        margin-top: 2rem;
        font-size: 0.85rem;
        opacity: 0.6;
        border-top: 1px solid currentColor;
        padding-top: 0.75rem;
      }
    </style>
  </head>
  <body>
    <h1>agents-js gateway API</h1>
    <p class="lede">This is the machine API surface, not a web page. There is no UI at this root.</p>
${humanLink}
    <h2>API surfaces on this host</h2>
    <ul>
      <li><a href="/.well-known/agent-card.json">Agent card</a> — <code>GET /.well-known/agent-card.json</code></li>
      <li><a href="/docs">Gateway docs</a> — <code>GET /docs</code></li>
      <li><code>POST /agent</code> — AG-UI run surface</li>
      <li><code>GET /events</code> — event stream (SSE)</li>
    </ul>

    <p class="note">agents-js · gateway API</p>
  </body>
</html>
`;
}

/**
 * Build the gateway root-signpost fetch handler. Self-routes on `GET ${path}`
 * (default `/`); returns `null` for every other path so the `additionalFetch`
 * chain falls through to the API routes — this handler must be composed LAST so
 * it only catches the otherwise-unhandled root. A non-GET request to the root
 * returns `405` with an `Allow: GET` header, mirroring the other gateway
 * endpoints.
 */
export function createGatewayRootHandler(
  config: GatewayRootConfig = {},
): (req: Request) => Promise<Response | null> {
  const path = config.path ?? DEFAULT_ROOT_PATH;
  const html = renderGatewayRootHtml(config);

  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    if (url.pathname !== path) return null;
    if (req.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: HTTP_METHOD_NOT_ALLOWED,
        headers: { Allow: "GET" },
      });
    }
    return new Response(html, {
      status: HTTP_OK,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  };
}
