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
