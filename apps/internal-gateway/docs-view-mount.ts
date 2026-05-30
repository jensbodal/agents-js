/**
 * Gateway `/docs` landing view (internal-only).
 *
 * The gateway is an internal-only surface — it is never exposed
 * publicly. This handler serves a small, framework-free HTML landing
 * page at `GET /docs` that orients an operator who lands on the bare
 * gateway host: it links out to the full public documentation and the
 * internal docs preview, and points at the live gateway surfaces
 * running on this same listener.
 *
 * This is the FIRST (and only) HTML the gateway emits — every other
 * route returns JSON or SSE. Kept deliberately dependency-free: one
 * inline template string, minimal inline CSS, no template engine, no
 * static-file subsystem. Self-routes on `GET /docs` and returns `null`
 * for every other request so it composes cleanly in the
 * `additionalFetch` chain without shadowing API routes.
 */

const DEFAULT_DOCS_PATH = "/docs";

/**
 * Canonical public documentation site. Public surface; the only
 * agents-js host exposed to the open internet.
 */
const DEFAULT_PUBLIC_DOCS_URL = "https://agents-js.bodal.dev";

/**
 * Internal documentation preview — the q4m mirror of the public docs
 * site. Internal-only.
 */
const DEFAULT_PREVIEW_DOCS_URL = "https://agents-js.q4m.dev";

const HTTP_OK = 200;
const HTTP_METHOD_NOT_ALLOWED = 405;

export interface DocsViewConfig {
  /** Path this handler answers on. Defaults to `/docs`. */
  path?: string;
  /** Public documentation site. Defaults to the canonical public host. */
  publicDocsUrl?: string;
  /** Internal docs preview mirror. Defaults to the internal preview host. */
  previewDocsUrl?: string;
}

/**
 * Escape a string for safe interpolation into an HTML attribute or text
 * node. The URLs are operator-configured (not request-derived), but
 * escaping keeps the template robust if config ever flows from a less
 * trusted source.
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
 * Render the gateway docs landing page. Exported so tests can assert on
 * the markup without constructing a `Request`.
 */
export function renderDocsViewHtml(config: DocsViewConfig = {}): string {
  const publicDocsUrl = escapeHtml(config.publicDocsUrl ?? DEFAULT_PUBLIC_DOCS_URL);
  const previewDocsUrl = escapeHtml(config.previewDocsUrl ?? DEFAULT_PREVIEW_DOCS_URL);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>agents-js gateway</title>
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
    <h1>agents-js gateway</h1>
    <p class="lede">Internal gateway surface. Not a public endpoint.</p>

    <h2>Documentation</h2>
    <ul>
      <li><a href="${publicDocsUrl}">Full documentation</a> — public docs site</li>
      <li><a href="${previewDocsUrl}">Documentation preview</a> — internal mirror</li>
    </ul>

    <h2>Live gateway surfaces</h2>
    <ul>
      <li><a href="/.well-known/agent-card.json">Agent card</a> — <code>GET /.well-known/agent-card.json</code></li>
      <li><a href="/events">Event stream</a> — <code>GET /events</code> (SSE)</li>
      <li><code>POST /agent</code> — AG-UI run surface</li>
    </ul>

    <p class="note">agents-js · internal gateway</p>
  </body>
</html>
`;
}

/**
 * Build the gateway docs-view fetch handler. Self-routes on
 * `GET ${path}` (default `/docs`); returns `null` for every other path
 * so the `additionalFetch` chain falls through to the next handler. A
 * non-GET request to the docs path returns `405` with an `Allow: GET`
 * header, mirroring the other gateway endpoints.
 */
export function createDocsViewHandler(
  config: DocsViewConfig = {},
): (req: Request) => Promise<Response | null> {
  const path = config.path ?? DEFAULT_DOCS_PATH;
  const html = renderDocsViewHtml(config);

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
