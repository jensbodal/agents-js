# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Starting from version 0.2.0, this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Per-package changes are currently captured in commit messages; this top-level
CHANGELOG tracks repo-wide shape changes (package additions, breaking protocol
moves, major feature lanes).

## [0.5.0](https://github.com/jensbodal/agents-js/compare/v0.4.0...v0.5.0) (2026-05-17)


### ⚠ BREAKING CHANGES

* **memory-local,memory:** `classifyMemoryOperation`, `createMemoryPolicyV12Gate`, `MemoryPolicyV12Options`, and `PolicyCategory` are removed from `@agents-js/memory-local`. No npm-published version exposed them; this breaks only in-repo dogfood consumers on the unreleased 0.4.x line.

### Added

* **docs:** Histoire component sandbox for acp-* primitives (v1) ([df2e383](https://github.com/jensbodal/agents-js/commit/df2e38399b10eb76ab45efcfff0bd40985265923))
* **examples:** host-memory-pilot — multi-actor host-side consumer smoke ([138d738](https://github.com/jensbodal/agents-js/commit/138d7381b9c711b69f9746ae8e4501a65838b0a6))
* **examples:** memory-provider-pilot — consumer-perspective smoke test ([a8982e5](https://github.com/jensbodal/agents-js/commit/a8982e5021ae0f43325a234937b69f25bce92f51))
* **extras:** MCP bus bridge consumer for AJS-9 ([e701411](https://github.com/jensbodal/agents-js/commit/e7014115caa2f90432500cf4d7cdc76da17f1e15))
* **gateway-runtime,a2a,a2a-client,host:** remote-gateway federation contract (v1 spec) ([2f19f95](https://github.com/jensbodal/agents-js/commit/2f19f95c4b9216a69759df3dcf112bc645806c83))
* **gateway-runtime,cli:** multi-runtime data structure + CLI flags (AJS-7 PR1) ([9b33b08](https://github.com/jensbodal/agents-js/commit/9b33b08645e3b86af051323a1a744871835a06e2))
* **gateway,host,a2a,acp-host:** multi-harness lane manager + agent-card harnesses surface (AJS-7 PR2) ([e489d05](https://github.com/jensbodal/agents-js/commit/e489d056e6c5d4180f5834e4110ec55571fcbeae))
* **gateway,host:** WS-bridge primary-routing-target switch (AJS-7 PR3) ([a6175ce](https://github.com/jensbodal/agents-js/commit/a6175cec57ae2a42c7f459c2570dc6c73729ab61))
* **host:** gateway bus SSE transport + admin publish handlers (AJS-8 PR2) ([1ce4738](https://github.com/jensbodal/agents-js/commit/1ce47383d9ceb98dcb7b2e115572348182251013))
* **host:** generic bridge primitive + Matrix adapter in extras (AJS-8 PR4) ([6cb84a2](https://github.com/jensbodal/agents-js/commit/6cb84a2866b3d4db8333911be793fa1bdef9949c))
* **host:** in-process gateway bus primitive for AJS-8 push channel ([f143673](https://github.com/jensbodal/agents-js/commit/f14367349040314d64301d576c078e3d50d6a1c4))
* **host:** wire audit-emitter wrapper into gateway runtime (AJS-8 PR3) ([59050a8](https://github.com/jensbodal/agents-js/commit/59050a83ca5fd437d79af6fef13da604ab173e12))
* **memory-local,memory:** drop policy taxonomy; add service actor kind ([683ad17](https://github.com/jensbodal/agents-js/commit/683ad178f381e9d63870b06f550e8f13d61837af))
* **memory-local,memory:** MemoryPolicy v1.2 enumerated permission-gate taxonomy ([432a461](https://github.com/jensbodal/agents-js/commit/432a46150c18dbd0814773334bfb329f8ebee971))
* **memory-local:** @agents-js/memory-local first-party durable provider ([d5104b0](https://github.com/jensbodal/agents-js/commit/d5104b0ef379c898d809be66c1661fdbcfe55fad))
* **memory:** @agents-js/memory primitive — types, provider interface, conformance harness ([0b2c79e](https://github.com/jensbodal/agents-js/commit/0b2c79e0a0dbedff754c79d8269ec5f658e63355))
* **ui-components:** AgentStatusBlock component + visual-state deriver ([5ded2ed](https://github.com/jensbodal/agents-js/commit/5ded2ed3696fcd123654fb1ff08a690a36b5cb97))


### Fixed

* **internal-gateway:** destroy host session on lane-manager construction failure ([1f1facb](https://github.com/jensbodal/agents-js/commit/1f1facbe9a1335f5d3a4c03cc17c66d23d146308))
* **memory-local:** drop node from engines; declare Bun-only at runtime ([c4df525](https://github.com/jensbodal/agents-js/commit/c4df52574b0454043c9917176fbe75181d0233de))
* **ui-components:** defensive element-narrowing on ws-bridge permission mapper ([0effc99](https://github.com/jensbodal/agents-js/commit/0effc999196c5749b8417bc5fab5c3c55afe25c7))
* **ui-components:** forward full ToolCall surface through ws-bridge permission mapper ([4f1bfdc](https://github.com/jensbodal/agents-js/commit/4f1bfdc7e10f7087dcbd4432bfd54cbe853a059a))

## [0.4.0](https://github.com/jensbodal/agents-js/compare/v0.3.2...v0.4.0) (2026-05-11)


### Added

* **a2a-client:** receive surface for ACP ToolCall rich payload ([e35e96f](https://github.com/jensbodal/agents-js/commit/e35e96f2787cf4819b2136bd68793846c3123a85))
* **a2a/cli:** surface ACP thought/tool/plan/commands/mode/usage events ([a2db9fa](https://github.com/jensbodal/agents-js/commit/a2db9fa7a28ea8f4397b72f3469498131e12f295))
* **a2a:** forward ACP ToolCall rich payload on the wire ([6a1dd50](https://github.com/jensbodal/agents-js/commit/6a1dd50595c3a759bfe1564e896d349c0af2202f))
* **acp-host,a2a,a2a-client:** surface ACP session_info_update end-to-end ([61f4988](https://github.com/jensbodal/agents-js/commit/61f4988c8f0a5449199512f6205a8d7b9a4b4577))
* **cli:** plan pane + mode/usage header badges + slash-cmd hint ([241aef0](https://github.com/jensbodal/agents-js/commit/241aef029f337f99cac501d31e6414bba208e248))
* **ui-components,web-ui:** wire acp-tool-call-detail into acp-chat-app ([a6c298b](https://github.com/jensbodal/agents-js/commit/a6c298ba))
* **ui-components:** forward rich tool-call payloads through HostState ([8095563](https://github.com/jensbodal/agents-js/commit/80955630))
* **ui-components:** integrate acp-tool-call-detail into acp-transcript ([3fd9d63](https://github.com/jensbodal/agents-js/commit/3fd9d638e3f0e8706bb12c34563e48d452cc5f41))
* **ui-components:** tool-call detail rendering primitives ([f4352bb](https://github.com/jensbodal/agents-js/commit/f4352bb2035ea48c585301a5bafc719a2e92c399))


### Fixed

* **acp-host:** forward ACP ToolCall locations/rawInput/rawOutput to ToolCallInfo ([ac33c9f](https://github.com/jensbodal/agents-js/commit/ac33c9f3))

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
