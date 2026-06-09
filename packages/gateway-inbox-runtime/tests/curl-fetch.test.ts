/**
 * Contract for the curl-backed `fetchImpl` transport adapter (`curlFetch`).
 *
 * On bun/node runtimes behind a macOS Local-Network/TCC restriction (BL-64),
 * `fetch` to a LAN gateway IP fails (EHOSTUNREACH) while `curl` reaches it.
 * `curlFetch` is the durable, permission-independent fix: a `typeof fetch`
 * adapter that routes the request through the `curl` binary, injected into
 * {@link HttpGatewayInboxClient} via its existing `fetchImpl` seam (zero
 * public-client-surface change). Shared by every bun/node consumer — the
 * Claude channel-adapter, the Codex receiver, pi's extension — so the
 * workaround is authored once, not per harness.
 *
 * These tests exercise the adapter against a REAL local HTTP server (no
 * child_process mocking): they pin the request-mapping (method/headers/body)
 * and response-mapping (status/ok/body) the gateway client actually relies on
 * (`.ok`, `.status`, `.text()`/`.json()` over JSON POSTs). They do NOT
 * reproduce the TCC wall itself — that is the runtime's property, not the
 * adapter's; the adapter's contract is "behaves like fetch via curl".
 */
import { describe, expect, test } from "bun:test";
import { curlFetch } from "../src/curl-fetch.ts";

/**
 * A throwaway echo server: replies 200 with a JSON body reflecting the request
 * (method, a chosen header, raw body), or a configured status for status tests.
 * Returns the base URL and a stop().
 */
function startEchoServer(status = 200): { url: string; stop: () => void } {
  let server: ReturnType<typeof Bun.serve> | undefined;
  for (let i = 0; i < 20; i++) {
    const port = 38_000 + Math.floor(Math.random() * 1_000);
    try {
      server = Bun.serve({
        port,
        async fetch(req) {
          const body = await req.text();
          const echo = {
            method: req.method,
            headerSeen: req.headers.get("x-probe") ?? null,
            contentType: req.headers.get("content-type") ?? null,
            body,
          };
          return new Response(JSON.stringify(echo), {
            status,
            headers: { "content-type": "application/json" },
          });
        },
      });
      break;
    } catch {
      // Retry on a rare port collision; this avoids relying on Bun port:0.
    }
  }
  if (!server) throw new Error("failed to start echo server");
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

describe("curlFetch — curl-backed fetchImpl transport adapter", () => {
  test("GET round-trips status and body", async () => {
    const srv = startEchoServer();
    try {
      const res = await curlFetch(`${srv.url}/health`);
      expect(res.status).toBe(200);
      expect(res.ok).toBe(true);
      const json = (await res.json()) as { method: string };
      expect(json.method).toBe("GET");
    } finally {
      srv.stop();
    }
  });

  test("POST maps method, headers, and JSON body to the request", async () => {
    const srv = startEchoServer();
    try {
      const res = await curlFetch(`${srv.url}/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-probe": "abc123" },
        body: JSON.stringify({ hello: "world" }),
      });
      expect(res.ok).toBe(true);
      const json = (await res.json()) as {
        method: string;
        headerSeen: string | null;
        contentType: string | null;
        body: string;
      };
      expect(json.method).toBe("POST");
      expect(json.headerSeen).toBe("abc123");
      expect(json.contentType).toBe("application/json");
      expect(JSON.parse(json.body)).toEqual({ hello: "world" });
    } finally {
      srv.stop();
    }
  });

  test("non-2xx status surfaces as ok=false with the status preserved", async () => {
    const srv = startEchoServer(404);
    try {
      const res = await curlFetch(`${srv.url}/missing`);
      expect(res.status).toBe(404);
      expect(res.ok).toBe(false);
      // Body is still readable — the client reads text() before checking ok.
      expect(typeof (await res.text())).toBe("string");
    } finally {
      srv.stop();
    }
  });

  test("a transport failure rejects (so the poller retries, cursor unchanged)", async () => {
    // Port 1 is reserved/unbound → curl exits non-zero (connection refused).
    await expect(curlFetch("http://127.0.0.1:1/unreachable")).rejects.toThrow();
  });

  test("rejects a non-http(s) URL before spawning (argv flag-smuggling defense)", async () => {
    // A `-`-prefixed or non-http URL must never reach curl's argv as a target —
    // curl would parse it as a flag (e.g. `-o/path` writes a file). Reject early.
    await expect(curlFetch("-o/tmp/pwned")).rejects.toThrow(/http/i);
    await expect(curlFetch("file:///etc/passwd")).rejects.toThrow(/http/i);
  });
});
