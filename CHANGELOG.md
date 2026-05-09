# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Starting from version 0.2.0, this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Per-package changes are currently captured in commit messages; this top-level
CHANGELOG tracks repo-wide shape changes (package additions, breaking protocol
moves, major feature lanes).

## [0.3.2](https://github.com/jensbodal/agents-js/compare/v0.3.1...v0.3.2) (2026-05-09)


### Internal

* adopt release-please for CHANGELOG + version automation ([9e52532](https://github.com/jensbodal/agents-js/commit/9e5253239806219c7bcf86f320601ecc25bfa256))

## [0.3.1] - 2026-05-09

### Changed

- All 18 `@agents-js/*` packages now ship with [npm provenance attestations](https://docs.npmjs.com/generating-provenance-statements). No functional changes vs. `0.3.0`.

### Internal

- Tag-driven CI release workflow with per-package Trusted Publishers replaces the previous local `npm publish` flow. No long-lived `NPM_TOKEN` is stored in the repo.
- `scripts/publish-all.ts` continues past per-package failures and reports a complete failure list at the end (was: stop at first error).

## [0.3.0] - 2026-05-09

### Fixed

- `@agents-js/cli`: streaming responses now paint incrementally in the TUI. Pre-fix, `bunx @agents-js/cli serve --harness claude` advertised `streaming: yes` but the reply snapped in all at once on completion. Fixes [#19](https://github.com/jensbodal/agents-js/issues/19).

### Added

- `@agents-js/acp-host`: new `AcpStreamingTranslator` — shared abstraction owning the canonical translation of ACP streaming `SessionUpdate` variants (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`) into typed sink calls. Sink-pattern API decouples translator from output format.

### Internal

- Deterministic streaming-render test coverage at translator-unit and end-to-end render layers (no LLM, no real ACP harness).
- `mock-acp` gains an opt-in `MOCK_ACP_STREAMING_TEXT=1` mode that emits one chunk per character — used by the end-to-end render gate.

## [0.2.2] - 2026-05-09

### Fixed

- Claude harness no longer errors with `Invalid permissions.defaultMode: auto.` on first message. **0.2.0 and 0.2.1 are broken on `bunx @agents-js/cli serve --harness claude`; users must upgrade to 0.2.2.** Fixes [#17](https://github.com/jensbodal/agents-js/issues/17).

### Internal

- Migrated claude harness from `@zed-industries/claude-agent-acp@0.23.1` to `@agentclientprotocol/claude-agent-acp@0.33.1` (canonical home moved to the `agentclientprotocol` GitHub org).
- Bumped `@zed-industries/codex-acp` 0.12.0 → 0.14.0.

## [0.2.1] - 2026-05-09

### Fixed

- `@agents-js/cli`: install + invoke now works under `npm`/`pnpm`/`yarn` (was: crashed at first invocation with `ERR_UNKNOWN_FILE_EXTENSION` due to a Bun-only transitive asset). The CLI is Bun-only; install via `bunx @agents-js/cli` or `bun add -g @agents-js/cli`. `engines.node` was dropped from `packages/cli/package.json`. Other 17 packages republished at 0.2.1 to keep workspace version uniformity; their behavior is unchanged from 0.2.0.

## [0.2.0] - 2026-05-08

Changes landing on the active feature branch. Entries are promoted into a dated release heading when cut.
