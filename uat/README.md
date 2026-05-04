# UAT scenarios (agents-js)

agents-js scoped User Acceptance Test scenarios. Pairs with the
workspace-level registry at
[`../../uat/`](../../uat/) — see that README for schema and conventions.

## Files

- `cli-serve.yaml` — `agents-js serve` command.
- `cli-client.yaml` — `agents-js client` command.
- `cli-send.yaml` — `agents-js send` command (non-interactive one-shot prompt).
- `cli-acp.yaml` — `agents-js acp` command.
- `cli-registry.yaml` — `agents-js registry` command.
- `cli-bridge.yaml` — `agents-js bridge` command (ephemeral single-session gateway).
- `mcp.yaml` — `agents-js mcp` command (renamed from `mcp-bridge` for brevity).
- `web-ui.yaml` — web-ui scenarios (`apps/web-ui/src/*.test.ts`).

## How scenarios map to existing tests

Most CLI scenarios resolve to describe blocks in `packages/cli/tests/`:

- `cli.test.ts` — "agents-js CLI" outer describe covering the top-level
  CLI + the `serve` command surface (help, non-interactive flags,
  curated harness, profile handling, IPv6 formatting, wizard fallback,
  runtime env override flags).
- `client.test.ts` — "client command" describe.
- `acp.test.ts` — three describes: `parseAcpCommandArgs`, `runAcpCommand`,
  `agents-js acp dispatch`.
- `registry.test.ts` — `runRegistryCommand` describe.

Web-ui scenarios use one describe per `apps/web-ui/src/*.test.ts` file
(normalizeHostBridgeUrl, resolveBrowserLaunchConfig, etc.).

## Planned / manual

Scenarios flagged `automation: planned` are intentional placeholders
for things the CLI does not currently test (SIGTERM shutdown, port
conflict surfacing, A2UI demo via browser). They stay here so that a
future session has an explicit target.
