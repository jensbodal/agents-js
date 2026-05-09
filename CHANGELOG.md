# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Starting from version 0.2.0, this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Per-package changes are currently captured in commit messages; this top-level
CHANGELOG tracks repo-wide shape changes (package additions, breaking protocol
moves, major feature lanes).

## [0.3.1-rc1] - 2026-05-09

Verification prerelease for the tag-driven Trusted-Publishers + OIDC publish workflow shipped in [#16](https://github.com/jensbodal/agents-js/pull/16). No functional changes from `0.3.0`. Publishes under the `rc` dist-tag — `latest` continues to resolve to `0.3.0`.

### Internal

- **`scripts/publish-all.ts`: continue past per-package failures and report all results at the end** (was: stop at first error). CI runs benefit from a complete failure list — surfacing all packages still missing Trusted-Publisher config in one workflow run instead of forcing per-tag iteration. Exit code is still non-zero if any package failed; only the loop semantics changed.

## [0.3.0] - 2026-05-09

### Fixed

- **`@agents-js/cli`: streaming render now paints incrementally.** Fixes [#19](https://github.com/jensbodal/agents-js/issues/19). Pre-fix, `bunx @agents-js/cli serve --harness claude` + `client` would advertise `streaming: yes` but the agent's reply snapped in all at once on completion. Root cause: `@opentui/core`'s `CliRenderer` runs at 30 FPS; the controller fires 25+ `message.delta` events synchronously in <1 ms (faster than the ~33 ms frame interval), so all transcript mutations land inside the same frame and only the final one paints. Fix calls `renderer.intermediateRender()` from the controller-event subscriber in `createClientApp` — opentui's documented escape-hatch for forcing a frame outside the natural cadence. The wire and `A2AClientController` were never broken; both correctly stream ~25 incremental deltas with monotonic `pendingAgentText`. Two earlier diagnoses (executor burst-emission; missing shared translator abstraction) turned out to be wrong; the actual gap was the renderer's frame loop.

### Refactored

- **`@agents-js/acp-host`: new `AcpStreamingTranslator` shared abstraction.** Owns the canonical "ACP `SessionNotification` → typed sink call" translation for the streaming-shaped `SessionUpdate` variants (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`). Sink-pattern API decouples the translator from output formats. AG-UI translator (`packages/host/src/acp-to-agui-translator.ts`) now routes `agent_message_chunk` events through this shared translator instead of inline; non-streaming variants (plan, mode, commands, config, usage, session_info) keep their existing per-consumer paths. No public API breakage; pre-1.0 internal-shape consolidation. v0.3.0 minor bump signals the architectural rearrangement.

### Added

- **Deterministic streaming-render test coverage** (no LLM, no real ACP harness):
  - **Layer 1** — `packages/acp-host/tests/streaming-translator.test.ts` (10 unit tests). `RecordingAcpStreamingSink` test double captures sink calls for assertion across text deltas, thought deltas, tool calls, parallel-translator isolation, and ignored non-streaming variants.
  - **Layer 3** — `packages/cli/tests/client-streaming-render.test.ts` end-to-end gate. Spawns `mock-acp` in streaming mode, drives a real `A2AClientController.sendTurn`, asserts the wire delivers >1 `message.delta` events with monotonic cumulative text and a prefix-invariant `pendingAgentText`.
- **`mock-acp` streaming-text mode** (`MOCK_ACP_STREAMING_TEXT=1`): emits one `agent_message_chunk` per character of `MOCK_ACP_REPLY`. Used by the Layer 3 gate; useful for any future streaming smoke against deterministic input.

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
