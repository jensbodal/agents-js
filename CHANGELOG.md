# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Starting from version 0.2.0, this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Per-package changes are currently captured in commit messages; this top-level
CHANGELOG tracks repo-wide shape changes (package additions, breaking protocol
moves, major feature lanes).

## [0.3.3](https://github.com/jensbodal/agents-js/compare/v0.3.2...v0.3.3) (2026-05-10)


### Added

* **a2a-client:** receive surface for ACP ToolCall rich payload ([e35e96f](https://github.com/jensbodal/agents-js/commit/e35e96f2787cf4819b2136bd68793846c3123a85))
* **a2a/cli:** surface ACP thought/tool/plan/commands/mode/usage events ([a2db9fa](https://github.com/jensbodal/agents-js/commit/a2db9fa7a28ea8f4397b72f3469498131e12f295))
* **a2a:** forward ACP ToolCall rich payload on the wire ([6a1dd50](https://github.com/jensbodal/agents-js/commit/6a1dd50595c3a759bfe1564e896d349c0af2202f))
* **acp-host,a2a,a2a-client:** surface ACP session_info_update end-to-end ([61f4988](https://github.com/jensbodal/agents-js/commit/61f4988c8f0a5449199512f6205a8d7b9a4b4577))
* **cli:** plan pane + mode/usage header badges + slash-cmd hint ([241aef0](https://github.com/jensbodal/agents-js/commit/241aef029f337f99cac501d31e6414bba208e248))
* **ui-components:** integrate acp-tool-call-detail into acp-transcript ([3fd9d63](https://github.com/jensbodal/agents-js/commit/3fd9d638e3f0e8706bb12c34563e48d452cc5f41))
* **ui-components:** tool-call detail rendering primitives ([f4352bb](https://github.com/jensbodal/agents-js/commit/f4352bb2035ea48c585301a5bafc719a2e92c399))

## [0.3.2](https://github.com/jensbodal/agents-js/compare/v0.3.1...v0.3.2) (2026-05-09)


### Fixed

* **release:** sync internal deps + bun.lock in release-please flow ([5fb9764](https://github.com/jensbodal/agents-js/commit/5fb9764f0583e2d4e08169af2526dc2abc7b9391))


### Internal

* adopt release-please for CHANGELOG + version automation ([9e52532](https://github.com/jensbodal/agents-js/commit/9e5253239806219c7bcf86f320601ecc25bfa256))
* release main ([490e8b6](https://github.com/jensbodal/agents-js/commit/490e8b69fcf4f03f4c72908b197d6b6767b8c638))
* **release:** add workflow_dispatch trigger to release.yml ([da0705e](https://github.com/jensbodal/agents-js/commit/da0705e0c4193dbd61f0c5b7372eaf02a2987332))
* **release:** reset manifest to 0.3.1 to unstick release-please ([3380660](https://github.com/jensbodal/agents-js/commit/338066063b2cd1f4d3d72a614bcbcb87acb13ddc))

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
