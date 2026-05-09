# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Starting from version 0.2.0, this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Per-package changes are currently captured in commit messages; this top-level
CHANGELOG tracks repo-wide shape changes (package additions, breaking protocol
moves, major feature lanes).

## [0.2.2] - 2026-05-09

### Fixed

- **Migrated claude harness to `@agentclientprotocol/claude-agent-acp@0.33.1`** (was `@zed-industries/claude-agent-acp@0.23.1`). The package's canonical home moved to the `agentclientprotocol` GitHub org and is now ~10 minor versions ahead of the legacy `@zed-industries/claude-agent-acp` line on npm (which is frozen at 0.23.1). Fixes [#17](https://github.com/jensbodal/agents-js/issues/17): `bunx @agents-js/cli@0.2.0/0.2.1 serve --harness claude` errored with `Invalid permissions.defaultMode: auto.` on first message because the old version's `resolvePermissionMode()` didn't include `auto` in its alias table and threw on unknown values. The new version includes `auto` and is now lenient (logs an error and falls back to `default` instead of throwing). **0.2.0 and 0.2.1 are broken on the serve flow; users must upgrade to 0.2.2.**

### Internal

- Bumped `@zed-industries/codex-acp` 0.12.0 → 0.14.0 (existing scope still canonical for codex; `@agentclientprotocol/codex-acp` is pre-stable at 0.0.x).
- Extended `GatewayRuntimeInstall.owner` union to include `"agentclientprotocol"`.

## [0.2.1] - 2026-05-09

### Fixed

- `@agents-js/cli`: revert published `dist/bin.mjs` shebang to `#!/usr/bin/env bun`. The 0.2.0 shebang was `#!/usr/bin/env node`, which let `npm`/`pnpm`/`yarn` install succeed but then crashed at first invocation with `ERR_UNKNOWN_FILE_EXTENSION` because the TUI's transitive dep `@opentui/core` ships `.scm` Tree-sitter assets that only Bun's loader resolves. The CLI is genuinely Bun-only; `engines.node` was dropped from `packages/cli/package.json` and the README now states the requirement explicitly. Install paths: `bunx @agents-js/cli` or `bun add -g @agents-js/cli`. Other 17 packages republished at 0.2.1 to keep workspace version uniformity; their behavior is unchanged from 0.2.0.

## [0.2.0] - 2026-05-08

Changes landing on the active feature branch. Entries are promoted into a dated release heading when cut.
