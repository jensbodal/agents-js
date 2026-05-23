---
name: agents-js
description: Use the agents-js CLI to expose ACP coding agents over A2A, bridge registered A2A agents into MCP, send one-shot prompts, and manage local agent registries. Use when a task needs Claude Code, Codex, OpenCode, Droid, Pi, or a custom ACP runtime to be launched, proxied, tested, or connected through agents-js. Skip: unrelated package management, generic TypeScript implementation, or agent workflows that do not involve the agents-js command surface.
---

# agents-js CLI

Use `agents-js` when you need to run or inspect ACP-compatible coding agents through the agents-js protocol bridge. The CLI is Bun-based and exposes ACP runtimes over A2A, turns A2A agents into MCP tools, and supports both interactive and headless client flows.

## Install This Skill

If the user asks you to install this skill, copy the output of `agents-js skill` into one of these locations:

- Codex global: `~/.codex/skills/agents-js/SKILL.md`
- Universal project: `.agents/skills/agents-js/SKILL.md`
- Universal global: `~/.agents/skills/agents-js/SKILL.md`

Create parent directories as needed. Prefer a project install when working in a repository and a global install when the user wants the skill available everywhere.

## Core Commands

- `agents-js serve --harness <id>` starts a long-lived A2A gateway over a curated ACP runtime such as `claude`, `codex`, or `opencode`.
- `agents-js bridge --harness <id>` starts an ephemeral gateway for one harness without reading or writing registry config.
- `agents-js acp --harness <id>` proxies stdio directly to an ACP runtime and keeps protocol bytes on stdout.
- `agents-js client --url <base-url>` opens the interactive A2A client TUI; add `--message "..."` for a one-shot client request.
- `agents-js send --url <base-url> "prompt"` sends a headless one-shot prompt to a running gateway.
- `agents-js mcp` starts an MCP stdio server that exposes registered A2A agents as tools.
- `agents-js registry add <name> <url>` registers an A2A agent; use `--kind acp --harness <id>` for ACP-backed entries.
- `agents-js skill` prints this installable skill document.

## Common Workflows

### Expose a Local Harness over A2A

```sh
agents-js serve --harness codex --port 7878
agents-js send --url http://127.0.0.1:7878 "summarize this repository"
```

Use `serve` when the gateway should stay up for repeated client, MCP, or cross-agent calls. Use `bridge` when you only need a temporary gateway for a single harness.

### Register Agents for Delegation

```sh
agents-js registry add reviewer http://127.0.0.1:7878
agents-js registry list
agents-js mcp
```

Use this when an MCP-capable host should call A2A agents as named tools.

### Validate a Runtime Boundary

```sh
agents-js acp --harness claude
agents-js acp --harness custom --acp-command ./bin/my-acp --acp-args-json '["--stdio"]'
```

Use `acp` when you need the raw ACP subprocess boundary. Diagnostics go to stderr; stdout is reserved for JSON-RPC protocol traffic.

## Guardrails

- Check `agents-js <command> --help` before inventing flags.
- Prefer curated harness IDs before custom commands.
- Keep `acp` stdout uncontaminated; shell banners or runtime warnings before JSON-RPC are protocol errors.
- Do not expose gateways on public interfaces unless the user explicitly asks and understands the network implications.
- Treat registry changes as durable user configuration; confirm intent before removing entries.

## When NOT to Use

- Do not use this skill for unrelated coding tasks that do not need the `agents-js` CLI.
- Do not use `agents-js mcp` when the user needs a regular HTTP server; it is an MCP stdio server.
- Do not use `agents-js acp` as a chat UI; use `agents-js client` or `agents-js send` for user-facing prompts.
