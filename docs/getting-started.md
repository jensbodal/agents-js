---
title: Getting Started
diataxis: tutorial
---

# Get started

> **Status:** Beta · **Validated by:** browser and CLI quickstart flows · **Contract:** [Beta Contract](/beta-contract)

By the end of this page you have a local ACP runtime running behind an A2A gateway, a live session you can talk to in a browser, AND a registry entry that other gateways will discover on the same trusted network. No code, no manual registry editing.

## Quickstart commands

```sh
mise install
bun run setup --runtime claude
bun run dev
```

That's the shortest checked-in path from a fresh clone to a working session.

### You should now see

- a launcher printing `Gateway URL`, `Gateway WS URL`, `Web UI URL`, and `Open URL`
- a browser at the printed `Open URL` with a connect dialog → press `Connect` → send `Hello` → reply streams into a transcript
- a fresh entry in `~/.agents-js/registry.json` with this gateway's name + URL — that's your machine becoming a node on whatever trusted network it's reachable from

The registry entry is what makes the next sections work without manual config.

## Prove the second wire (CLI)

In a second terminal:

```sh
bun run --cwd packages/cli client -- --url http://127.0.0.1:<printed-port>
```

You can also connect by full agent card URL:

```sh
bun run --cwd packages/cli client -- --card http://127.0.0.1:<printed-port>/.well-known/agent-card.json
```

Send `Hello`, then `What is the last message I sent?`. The TUI sees the same session the browser is talking to — A2A is the lingua franca underneath both surfaces.

## Prove the third wire (MCP host)

The same gateway answers any MCP host (Claude Code, Cursor, Zed) via `@agents-js/mcp-bridge`. One-line summary: point the host's MCP config at the gateway's MCP-bridge endpoint and tools load on demand. Full config and progressive-discovery details: [Surfaces → MCP host](/surfaces#mcp-host).

## What just happened (60-second recap)

- `bun run dev` ran the launcher, which spawned the ACP runtime, the A2A gateway, and the reference web UI.
- The gateway **auto-registered** itself into `~/.agents-js/registry.json` and started a periodic peer sync — see [Surfaces → Agent Registry](/surfaces#agent-registry) for the trust posture and how to add a peer machine.
- The browser, CLI, and any MCP host all reach the same ACP session because A2A is the network surface the gateway speaks.
- The registry made the gateway **discoverable to peers on the same trusted network**; it did **not** make it public-internet-safe — that's a separate hardening track in the [Beta Contract](/beta-contract).

## Prove session continuity (operator validation)

The session lives in the gateway, not the surface. Restart the surface, the session is still there. Verify it:

1. With `bun run dev` running, in the browser send `My favorite color is teal.` and wait for the reply.
2. Stop and restart the launcher: `Ctrl-C` the `bun run dev` process, then `bun run dev` again. Note the new printed gateway port (it's ephemeral).
3. In a second terminal, attach the CLI client to the new port:
   ```sh
   bun run --cwd packages/cli client -- --url http://127.0.0.1:<printed-port>
   ```
4. Ask `What was my last message?`. The agent should recall `My favorite color is teal.`

If it does, persistence is wired end-to-end: the ACP runtime kept its session, the gateway re-attached, and the CLI reached the same logical conversation the browser was talking to. If it doesn't, the runtime did not persist — check the runtime's own session-store config (Anthropic Claude Agent stores under `~/.claude-agent`).

## Try it locally in your browser

The [Playground](/playground) page runs a local docs agent entirely in your browser using WebGPU. It downloads a small model on first use, then answers questions about agents-js without any server round-trip.

## Where to go next

- I want to understand the seven protocols → [Protocols Primer](/protocols-primer)
- I want to drive it from a different host (Obsidian plugin, custom desktop) → [Surfaces](/surfaces)
- I want to embed ACP in my own app → [Harness Guide](/harness-guide)
- I want to know exactly what beta means here → [Beta Contract](/beta-contract)
- I want a peer agent on my tailnet to find this one → [Surfaces → Agent Registry](/surfaces#agent-registry)
- I want to try it in my browser → [Playground](/playground)

## Choose a different runtime

The default examples use `claude` (the Anthropic Claude Agent ACP harness). Other runtimes are available at different validation levels; check the [Runtime Matrix](/surfaces#runtime-matrix) before switching away from the default example. Use `--runtime <id>` only after confirming that runtime's status, install path, and auth requirements match your local setup.

## If something didn't work

- **Port already bound** — the launcher picks an ephemeral port; if you see `EADDRINUSE`, kill any prior `bun run dev` process and retry.
- **Runtime not on PATH** — `bun run setup --runtime <name>` runs the repo doctor; if it can't find the harness binary, install per the runtime's own instructions and retry.
- **Registry path** — defaults to `~/.agents-js/registry.json`. Override with `AGENTS_JS_REGISTRY=/your/path` if you want it elsewhere. The resolver lives in `packages/a2a-client/src/node-autoregister.ts`.

## Contributor quickstart

For contributors working on `agents-js` itself, the same quickstart commands are the minimum-command path. After the first run, the validation lanes confirm nothing is broken before opening a PR:

```sh
bun run check
bun run test
bun run docs:build
```

Optional: `bun run browser:smoke` (real-browser end-to-end check, not CI-gated). The happy-dom component suite in `packages/ui-components/tests` covers the same assertions without a real browser. Full contributor workflow: [Develop → Contribute](/develop/contribute).
