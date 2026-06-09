/**
 * Curl-backed `fetchImpl` transport adapter (BL-64 durable fix).
 *
 * On bun/node runtimes subject to a macOS Local-Network/TCC restriction, the
 * built-in `fetch` cannot reach a LAN gateway IP (fails EHOSTUNREACH) while the
 * `curl` binary can. {@link curlFetch} routes an HTTP request through `curl`
 * instead, presenting a `typeof fetch` surface so it drops into
 * {@link HttpGatewayInboxClient} via its existing `fetchImpl` option — no change
 * to the client's public surface. It is permission-independent (unlike granting
 * bun/node the Local-Network entitlement, which is silently revoked on upgrade),
 * and uses `node:child_process` (NOT `Bun.spawn`) so a single shared primitive
 * serves every consumer: the Claude channel-adapter (bun), pi's extension
 * (node), and the Codex receiver.
 *
 * **Scope — deliberately a transport adapter, not a general `fetch` polyfill.**
 * It covers exactly what the gateway client needs: request method, request
 * headers, a string request body (JSON POSTs for mint challenge/redeem,
 * `get_messages`, `send_message`), and the response status + body (read via
 * `.ok` / `.status` / `.text()` / `.json()`). It does NOT surface response
 * headers, and it does not handle non-string `BodyInit` (Blob/FormData/streams).
 * A non-zero `curl` exit rejects the promise, so a transport failure propagates
 * as a poller retry (the seen-cursor does not advance on failure).
 */
import { spawn } from "node:child_process";

/** Marker appended via `curl -w` to carry the HTTP status after the body. */
const STATUS_SENTINEL = "\n";

/**
 * Route a single HTTP request through the `curl` binary and adapt the result
 * into a {@link Response}. Conforms to `typeof fetch` for the request shapes the
 * gateway client uses (see module docs for the deliberate scope limits).
 */
const curlFetchImpl = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> =>
  new Promise<Response>((resolve, reject) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // Argv flag-smuggling defense: a `-`-prefixed URL (e.g. `-o/path`) would be
    // parsed by curl as a flag rather than a target. Require an http(s) scheme
    // up front, and pass the URL after a `--` end-of-options separator below.
    if (!/^https?:\/\//i.test(url)) {
      reject(new Error("curlFetch: only http(s) URLs are supported"));
      return;
    }

    const args = [
      "-sS", // silent, but still print errors to stderr
      "-X",
      init?.method ?? "GET",
      "--connect-timeout",
      "10",
      // Bound the WHOLE transfer, not just the connect phase: a connected-but-
      // hung gateway response would otherwise never resolve and wedge the poll
      // loop. With a cap it fails fast into the retry path (cursor unchanged).
      "--max-time",
      "30",
      "-w",
      `${STATUS_SENTINEL}%{http_code}`,
    ];
    new Headers(init?.headers).forEach((value, key) => {
      args.push("-H", `${key}: ${value}`);
    });

    const hasBody = init?.body != null;
    if (hasBody) {
      if (typeof init?.body !== "string") {
        reject(new Error("curlFetch: only string request bodies are supported"));
        return;
      }
      // Read the body from stdin to avoid argv length/escaping limits.
      args.push("--data-binary", "@-");
    }
    // `--` stops curl option parsing so the URL can never be read as a flag.
    args.push("--", url);

    const proc = spawn("curl", args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("error", reject);

    if (hasBody) {
      proc.stdin.write(init?.body as string);
      proc.stdin.end();
    }

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`curlFetch: curl exited ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      // The status was appended after the body via `-w`; split it back off.
      const splitAt = stdout.lastIndexOf(STATUS_SENTINEL);
      const body = splitAt >= 0 ? stdout.slice(0, splitAt) : stdout;
      const statusText = splitAt >= 0 ? stdout.slice(splitAt + STATUS_SENTINEL.length) : "";
      const status = Number(statusText.trim()) || 502;
      resolve(new Response(body, { status }));
    });
  });

/**
 * The curl-backed fetch adapter, presented as `typeof fetch` so it drops into
 * any `fetchImpl` slot. `typeof fetch` carries a `preconnect` hint; this
 * transport opens no speculative connection (every call spawns a fresh `curl`),
 * so `preconnect` is a deliberate no-op. The gateway client only ever invokes
 * the call signature, never `preconnect`.
 */
export const curlFetch: typeof fetch = Object.assign(curlFetchImpl, {
  preconnect: () => {},
});
