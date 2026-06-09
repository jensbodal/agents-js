# Internal Gateway

This app is the lower-level dev entrypoint for the repo's gateway wiring.
The operator-facing surface now lives in `packages/cli` as the `agents-js serve` and `agents-js client` commands.
For normal usage, prefer the CLI and the docs pages in `docs/`.

This app is also part of the upstream proof surface for `agents-js`: it is the checked-in gateway
and host wiring used to validate runtime boot, bridge behavior, and the reference browser app from
source.

## Runtime Selection Policy

The dev app's default runtime is selected in `apps/internal-gateway/gateway.config.ts`.

- Runtime selection is checked in.
- Core runtime selection does not come from ambient env vars.
- If this app ever gains runtime overrides, they must be explicit and validated.

## Supported Runtimes

| Runtime ID | Display Name | Ownership                                             | Resolution                                                                                          |
| ---------- | ------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `opencode` | OpenCode ACP | External CLI                                          | Resolved from `PATH`                                                                                |
| `claude`   | Claude ACP   | Upstream via `@agentclientprotocol/claude-agent-acp` (formerly `@zed-industries/claude-agent-acp`) | Resolved from `PATH`, then falls back to `apps/internal-gateway/node_modules/.bin/claude-agent-acp` |
| `gemini`   | Gemini ACP   | External CLI                                          | Resolved from `PATH`                                                                                |

## Runtime Provenance

- `opencode` is an external ACP-capable CLI. This repo expects `opencode` to already be installed and available on `PATH`.
- `claude` uses the upstream-canonical ACP runtime package `@agentclientprotocol/claude-agent-acp` (the same package previously published as `@zed-industries/claude-agent-acp`; the canonical home moved to the `agentclientprotocol` org).
- `claude-agent-acp` is not maintained in this repo. It is an external runtime that this gateway can launch.

## How Resolution Works

- Shared runtime definitions live in `packages/gateway-runtime/src/runtimes.ts`.
- `apps/internal-gateway/runtimes.ts` keeps the app-local workspace-bin fallback for the dev entrypoint.
- Host orchestration (executor, AG-UI / WS bridges, surface broadcaster, host session) lives in `@agents-js/host`. This app collapses to CLI/argv parsing, runtime selection wiring, and signal handling on top of that package.
- The gateway resolves the configured runtime before boot.
- `opencode` must resolve from `PATH`.
- `claude` can resolve from `PATH`, but this repo also installs it as a workspace dependency so `bun install` provides the app-local fallback binary.
- `@agents-js/pi-acp` and `@agents-js/droid-acp` are listed as runtime `dependencies` even though no source file imports them: the gateway's curated runtime registry resolves the `pi-acp` and `droid-acp` binaries from `node_modules/.bin` (via `resolvesFromWorkspaceBin`), and bun only symlinks those binaries into the gateway's `node_modules/.bin` when the workspace packages are declared as deps here.
- The `mock-acp` runtime is registered only when `AGENTS_JS_ENABLE_MOCK_ACP_RUNTIME=1` (CI / deterministic e2e gate). Its binary is provided by `@agents-js/gateway-runtime`, which this app already depends on.

## Running the Gateway

1. Run `bun install`.
2. Set the checked-in runtime in `apps/internal-gateway/gateway.config.ts`.
3. Start the lower-level gateway with `bun run --cwd apps/internal-gateway dev` or `bun run gateway`.

For a repo-installed startup check that does not depend on a personal `opencode` install, run:

```sh
bun run --cwd apps/internal-gateway check:runtime
```

`--runtime` is an explicit validated override for this dev entrypoint. `--check` resolves the
runtime and exits before binding an HTTP server. This proves repo-installed startup wiring, not an
isolated app-only install boundary.

For the operator-facing flow, use:

```sh
bun run serve
bun run client
```

See the docs pages for the CLI, client, examples, runtime matrix, streaming status, and tooling workflow.

## Root Signpost (`GET /`)

This host is the machine API (`/jsonrpc`, `/.well-known/*`, `/agent`, `/docs`,
the bus endpoints). It is NOT the human web UI — the web UI is a separate app
(`apps/web-ui`) served from a separate human edge, and must not be mounted into
this API process. To remove the "two hostnames" footgun (a human typing the API
host hitting a bare `404`), `GET /` returns an always-on signpost that
identifies the host as the machine API and links the human edge when its URL is
configured. This is the in-app half of the fix; the complete fix is the edge
alias/redirect (operator/deploy lane, BL-59).

Environment contract:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTS_GATEWAY_HUMAN_URL` | unset | Human-facing web-UI URL the root signpost links (e.g. `https://ajs-gateway.q4m.dev/`). Deployment-specific; set it in the deployed gateway env so the API host points humans at the real UI. Unset → the signpost identifies the API without a link. |

## Plane Webhook Receiver

The gateway exposes an optional Plane webhook receiver:

```text
POST /webhooks/plane
```

V1 behavior:

- Verifies `X-Plane-Signature` with HMAC-SHA256 over the request body.
- Reads the secret from `PLANE_WEBHOOK_SECRET`, or from `gopass show -o services/plane/webhook_secret` by default.
- Accepts Plane issue update payloads whose current state name is `Done`.
- Emits a structured `plane_webhook_issue_done` log event.
- Optionally sends a one-line Matrix coordination message through the matrix-chat CLI.
- Acknowledges non-Done updates with `200` and `ignored: true` so Plane does not retry noise.

Environment contract:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PLANE_WEBHOOK_SECRET` | unset | Direct webhook secret override. Prefer gopass in local deployments. |
| `PLANE_WEBHOOK_SECRET_GOPASS_PATH` | `services/plane/webhook_secret` | gopass path used when direct secret is not set. |
| `PLANE_WEBHOOK_NOTIFY_ENABLED` | disabled | Set to `1`, `true`, `on`, or `yes` to enable Matrix sends. |
| `PLANE_WEBHOOK_MATRIX_AGENT` | unset | Matrix identity used by the notification command. |
| `PLANE_WEBHOOK_MATRIX_ROOM` | unset | Matrix room alias or room id for notifications. |
| `PLANE_WEBHOOK_MATRIX_CLIENT` | unset | Matrix CLI script path. Required when Matrix sends are enabled. |
| `PLANE_WEBHOOK_BUN` | first `bun` on `PATH` | Bun executable used for the Matrix CLI. |

## Gitea Webhook Bridge

The gateway exposes an optional Gitea webhook receiver and matching
Matrix-output bus consumer (AJS-59 v1):

```text
POST /webhooks/gitea
```

V1 behavior:

- HMAC-SHA256 verification against the raw request body, before JSON parse.
- Per-repo + per-event-type allowlists evaluated after HMAC.
- In-memory dedupe by `X-Gitea-Delivery` with a 1-hour TTL.
- Subscribes to `gateway.gitea.event-received` and sends a one-line Matrix
  message per allowed event via the configured subprocess.

The route is mounted ONLY when `GITEA_WEBHOOK_SECRET` is set — the
gateway boots unchanged in dev. If the secret is set without
`GITEA_BRIDGE_SEND_SCRIPT`, the gateway fails fast at startup with a
clear error.

Environment contract:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GITEA_WEBHOOK_SECRET` | unset | Enable gate + HMAC secret matching the Gitea webhook config. |
| `GITEA_BRIDGE_SEND_SCRIPT` | unset (required when enabled) | Absolute path to a send-matrix subprocess. The script must accept `--as <identity>`, `--stdin`, and an optional `--room <id>`. |
| `GITEA_BRIDGE_ROOM` | unset | Matrix room ID passed through to the send script as `--room`. |
| `GITEA_BRIDGE_ALLOWED_REPOS` | unset (allow all) | CSV of `owner/name` entries; trailing commas and whitespace tolerated. |
| `GITEA_BRIDGE_IDENTITY` | `gitea-bot` | Matrix identity passed as `--as` to the send script. |

End-to-end shape:

```
Gitea repo ─▶ POST /webhooks/gitea ─▶ HMAC verify + dedupe ─▶ bus
                                                                │
                                              gitea-bus-consumer┘ ─▶ send-matrix subprocess ─▶ Matrix
```

See `extras/gitea-bridge/README.md` for the bridge package details and
the Gitea webhook UI configuration table.

## Agents-MCP Tool Surface (AJS-56 / AJS-57)

The gateway exposes an optional HTTP tool surface for the unified
`agents.send_message` toolchain. Mounted ONLY when
`AGENTS_MCP_JWT_SIGNING_KEY` is set in env; absent → no route mounted,
no auth surface, no behavior change.

```text
POST /api/agents/send_message     # JWT-bearer; routes to Matrix or inbox
POST /api/agents/get_messages     # JWT-bearer; reads identity's own inbox
POST /api/agents/admin/mint       # admin-bearer; dev/dogfood JWT mint
```

V1 behavior:

- HS256-signed session JWTs (AJS-57). Per-call verification of
  signature + `iss` + `aud` + `exp` + `sub` + `cid`. Scope claim is
  1:1 with MCP tool names (e.g. `["matrix.send_message", "matrix.read"]`).
- Identity is server-resolved from the JWT `sub` claim. Caller
  attempts to inject `as_agent` / `sender` / `from` in the request
  body are silently ignored.
- Per-tool scope ACL: route presence in the target's `AGENTS_MCP_TARGETS_JSON`
  entry determines required scope, NOT whichever scope the caller carries.
  If the entry has an `inbox.session` route, `inbox.deliver` is MANDATORY
  (inbox is the durable substrate per AJS-65; a caller cannot bypass
  inbox-write by lacking the inbox scope). `matrix.send_message` is
  additionally required if the entry has `matrix.room` AND the caller
  wants the matrix notification overlay to fire. Missing scope → 403
  (not 401 — auth ok, not permitted).
- Target directory is in-memory (v1 stub for the AJS-55 trust manifest;
  populated from `AGENTS_MCP_TARGETS_JSON`). Unknown target → 404
  with structured `{error, target, correlation_id}`.
- Matrix substrate spawns the configured send-matrix subprocess
  with `--as <identity>`, mirroring the AJS-59 adapter pattern.
- `/admin/mint` is a deliberate v1 stub for AJS-55 challenge
  verification; gate it with `AGENTS_MCP_ADMIN_TOKEN` (default
  unset → 404).

Environment contract:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTS_MCP_JWT_SIGNING_KEY` | unset | Enable gate + HS256 secret (≥32 bytes). Loaded from gopass per host. |
| `AGENTS_MCP_JWT_ISSUER` | unset (required when enabled) | Canonical gateway name (`iss` claim). |
| `AGENTS_MCP_JWT_AUDIENCE` | `agents-js-mcp` | Expected `aud` claim. |
| `AGENTS_MCP_SEND_SCRIPT` | unset (required when enabled) | Absolute path to send-matrix subprocess (`--as`, `--stdin`, `--room`). |
| `AGENTS_MCP_AGENT_MSG_BIN` | unset | Absolute path to the `agent-msg` CLI binary. Enables `agents.get_messages` + inbox routing for `agents.send_message`. Without it, inbox-routed targets return `send-failed`. |
| `AGENTS_MCP_TARGETS_JSON` | `{}` | JSON map `target → { matrix?: { room }, inbox?: { session } }`. Allow-list of routable agents; either route may be present. |
| `AGENTS_MCP_ADMIN_TOKEN` | unset | When set, enables the `/admin/mint` endpoint. Disable in production until AJS-55 ships. |
| `AGENTS_MCP_JWT_TTL_SECONDS` | `900` (15 min) | JWT expiry from mint time. |

Dogfood quickstart:

```sh
# 1. Mint a JWT (admin-gated). Per AJS-65 inbox-durable contract, the
#    primary required scope for any send_message call to an inbox-
#    enabled target is `inbox.deliver`. Add `matrix.send_message` if you
#    also want the matrix notification overlay to fire (dual-route case).
curl -X POST http://gateway:9321/api/agents/admin/mint \
  -H "Authorization: Admin $AGENTS_MCP_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sub":"codex-hostname-null","scopes":["inbox.deliver","matrix.send_message","inbox.read"],"cid":"smoke-001"}'
# → { "jwt": "...", "expires_in": 900, ... }

# 2. Call the tool with the JWT:
curl -X POST http://gateway:9321/api/agents/send_message \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"target":"ajs-claude","body":"hello from codex"}'
# → For a dual-route target (matrix + inbox configured):
#   {
#     "ok": true,
#     "inbox_message_id": "019e...",          // durable storage id
#     "inbox_created_at": "2026-05-23T...",   // present iff inbox_message_id present
#     "event_id": "$..."                       // matrix notification id (pointer-only body)
#   }
# → For a matrix-only target (legacy back-compat):
#   { "ok": true, "event_id": "$..." }
# → For an inbox-only target:
#   { "ok": true, "inbox_message_id": "...", "inbox_created_at": "..." }
#
# Failure shapes:
# → 403 scope-not-granted: `{"ok":false,"error":"scope-not-granted","message":"..."}`
# → 500 inbox-write-failed: `{"ok":false,"error":"inbox-write-failed","message":"..."}`
#   (matrix NOT attempted — durable storage failed)
# → 200 degraded success (matrix notification failed but inbox written):
#   {"ok":true,"inbox_message_id":"...","matrix_notification_error":"..."}
```

### Substrate prerequisites stubbed in v1

Per AJS-56 design `docs/research/agents-js-hosted-mcp-tool-provider-design-2026-05-20.md`:

- **AJS-55 trust manifest** stubbed by `AGENTS_MCP_TARGETS_JSON`.
  Eventual signed-peer-record loader replaces this without changing
  the read API (`TargetDirectory.resolve`).
- **AJS-55 challenge verification** stubbed by `AGENTS_MCP_ADMIN_TOKEN`
  + the `/admin/mint` endpoint. Eventual ed25519 challenge flow
  replaces this without changing the JWT verify contract.
- **AJS-54 host bootstrap** — env distribution + `services/agents-js/identity/<agent>/key` provisioning is the deployment role's responsibility (not this code).
- **AJS-58 AgentInboxProvider** — directory entries with `.inbox.session`
  route through a subprocess wrapper around the `agent-msg` CLI when
  `AGENTS_MCP_AGENT_MSG_BIN` is set. Per AJS-65 (replacing the prior
  matrix > inbox exclusive precedence): inbox is the durable delivery
  substrate; matrix is the notification overlay. For a dual-route entry
  (both inbox.session + matrix.room), `agents.send_message` writes the
  full body to the inbox FIRST then fires a pointer-only matrix
  notification (`see inbox: ${inbox_message_id}`). Matrix-only entries
  (legacy back-compat, no inbox.session) keep the full-body matrix-send
  semantics. `agents.get_messages` reads the identity's OWN inbox
  session only; cross-agent read requires a future `inbox.read_all` scope.
