# @agents-js/gitea-bridge

Gitea webhook receiver + bus publisher. Verifies HMAC signatures on
incoming webhook deliveries, dedupes by `X-Gitea-Delivery`, filters by
allowlisted event type + repo, and publishes typed
`gateway.gitea.event-received` envelopes onto the agents-js gateway bus.

A first-party bus consumer in `@agents-js/host` subscribes to those
envelopes and forwards them as Matrix messages (or any other sink — the
consumer takes a pluggable `send` callback).

```
Gitea repo ──▶ HTTP POST /webhooks/gitea ──▶ createGiteaWebhookHandler ──▶ gateway bus
                                                                              │
                                                       startGiteaBusConsumer ─┘ ──▶ send-matrix.py
```

The receiver and the consumer are independent units: you can run the
receiver without a consumer (the envelopes sit on the bus, available to
any subscriber), or wire a different consumer for a different sink.

## Receiver

`createGiteaWebhookHandler({ bus, secret, ... })` returns a
`(req: Request) => Promise<Response>` handler suitable for any
`Bun.serve` / `node:http` / framework route.

```ts
import { createGiteaWebhookHandler } from "@agents-js/gitea-bridge";
import { createGatewayBus } from "@agents-js/host";

const bus = createGatewayBus();
const handler = createGiteaWebhookHandler({
  bus,
  secret: process.env.GITEA_WEBHOOK_SECRET!,
  // Optional — defaults to ["pull_request", "push", "release", "check_run"].
  allowedEventTypes: ["pull_request", "push", "release", "check_run"],
  // Optional — defaults to all repos. Allowlist of `owner/name` strings.
  allowedRepos: ["jensbodal/agents-js"],
});

Bun.serve({
  port: 8081,
  routes: {
    "/webhooks/gitea": { POST: handler },
  },
});
```

### Security model

- HMAC-SHA256 verified against the **raw request bytes**, before JSON
  parsing — guarantees the signature covers exactly what the client
  sent.
- Constant-time comparison via `crypto.timingSafeEqual`.
- Bare-hex and `sha256=<hex>` (GitHub-compatible) signature shapes both
  verify identically; the prefix is stripped defensively.
- Missing or invalid signature → `401`, no publish, no log of the body.
- Per-repo + per-event-type allowlists evaluated **after** HMAC, so
  dropped events still authenticate.
- In-memory dedupe by `X-Gitea-Delivery` with a 1-hour TTL — replays
  return `200 OK` with `{"accepted": false, "reason": "duplicate delivery_id"}`
  and do not re-publish. Repo / event-type allowlist misses return the
  same `accepted: false` shape with a corresponding `reason`.

### Configure Gitea

In your Gitea repo, **Settings → Webhooks → Add Webhook → Gitea**:

| Field        | Value                                                   |
|--------------|---------------------------------------------------------|
| Target URL   | `https://<gateway-host>/webhooks/gitea`                 |
| HTTP Method  | `POST`                                                  |
| POST Content | `application/json`                                      |
| Secret       | the same string passed to `createGiteaWebhookHandler`'s `secret` |
| Trigger On   | "Custom Events" → check `Pull Request`, `Push`, `Release`, `Check Run` |
| Active       | ✓                                                       |

Gitea sends `X-Gitea-Signature`, `X-Gitea-Event`, `X-Gitea-Delivery`
headers; the receiver reads all three.

## Bus consumer (Matrix output)

`startGiteaBusConsumer({ bus, send, ... })` subscribes to
`gateway.gitea.event-received` and invokes the injected `send` callback
with a human-readable Matrix body:

```
[gitea/<repo>] <subject> by <actor>[: <title>][ — <target_url>]
```

`<subject>` resolves to e.g. `PR opened`, `push`, `release created`,
`check_run completed`.

```ts
import { startGiteaBusConsumer } from "@agents-js/host";
import { spawn } from "node:child_process";

const consumer = startGiteaBusConsumer({
  bus,
  identity: "gitea-bot",
  send: async ({ body, identity, room }) => {
    // Production wiring: spawn the send-matrix.py subprocess.
    const proc = spawn(
      "python3",
      ["/path/to/send-matrix.py", "--as", identity, "--stdin", ...(room ? ["--room", room] : [])],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    proc.stdin.end(body);
    const code: number = await new Promise((r) => proc.on("exit", (c) => r(c ?? 1)));
    if (code !== 0) throw new Error(`send-matrix.py exited ${code}`);
  },
});

// Later: consumer.stop();
```

### Failure isolation

The consumer catches errors from `send` and logs them via the injected
logger (defaults to `console.warn`). One bad subprocess invocation does
**not** take down the subscription. Durable queueing + retry-backoff are
explicitly out of v1 scope — they belong in the layer below `send`, not
in the consumer.

### Migration to a tool provider

Post-AJS-56, the `send` callback can be replaced by a thin adapter onto
`MatrixToolProvider.send` (verified via AJS-57 JWT). The
`GiteaSendFunction` contract is stable; only the call site at
gateway-startup changes.

## See also

- AJS-59 design: `docs/research/agents-js-bridges/gitea-webhook-2026-05-20.md`
- Matrix-side equivalent: `extras/matrix-bridge/` + `matrix-bus-consumer.ts`
