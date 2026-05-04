# Contributing to agents-js

Repo-wide agent workflow and tracker rules live in [`AGENTS.md`](./AGENTS.md). Keep this file focused on contributor setup, commands, and PR expectations.

## Setup

```sh
mise install
bun run setup
```

## Development

```sh
bun run dev    # starts gateway + web UI
```

Or start the gateway with a specific runtime:

```sh
vp run @agents-js/cli#serve -- --harness claude
```

Connect the client in another terminal:

```sh
vp run @agents-js/cli#client -- --url http://127.0.0.1:<port>
```

## Quality Checks

Gates come in three tiers. `bun run setup` wires `core.hooksPath` to `.githooks/`, so the
pre-commit and pre-push hooks fire automatically once you've run setup.

| Tier | Command | What it runs | Where |
|------|---------|--------------|-------|
| pre-commit | auto-fix + `bun run check` | `bun run format` + `biome check --write` (safe auto-fixes) + preflight, `tsc --noEmit`, biome, docs-api drift | local, on `git commit` |
| pre-push | `mise run ci` | `install` + `check` + `test:vp` (parallel build + unit tests via vp) | local, on `git push` |
| CI | `bun run ci` | `check` + `test` + `docs:build` + `e2e:gateway` + `browser:smoke` | hosted CI |

The pre-commit hook auto-formats and auto-fixes safe lint before running `check`, so format/lint nits never block a commit. The final `check` step still enforces typecheck, unfixable lint, and generated-doc drift — real errors must be fixed manually.

Bypass pre-push for intentional WIP pushes: `git push --no-verify` or `SKIP_PREPUSH=1 git push`.

```sh
bun run ci             # deterministic upstream gate (check + test + docs:build + e2e:gateway + browser:smoke)
mise run ci            # local pre-push gate (install + check + test:vp)
bun run docs:build     # docs + API reference build (must be warning-free)
bun run browser:smoke  # canonical mock browser proof (isolated headless Playwright)
bun run e2e:web:live -- --runtime claude  # canonical live browser e2e
```

### Real-runtime gate (`e2e:runtime`)

`bun run ci` now includes a real-runtime A2A smoke against the first detected ACP runtime
(preferring `opencode`, falling back to a workspace-installed `@zed-industries/claude-agent-acp`).
If neither is available, the gate skips gracefully with a loud `SKIPPED` warning and exit 0 —
missing runtimes are treated as a host-environment issue, not a repo bug.

The `opencode` runtime loads user-environment plugins by default. Set
`AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS=1` to append `--pure` as an opt-in workaround when a
broken plugin (for example `oh-my-openagent`'s ZWSP sort-prefix injection) needs to be
neutralized. Gateway operators also see runtime diagnostics on stderr via
`--print-logs --log-level INFO` by default; override the level with
`AJS_RUNTIME_LOG_LEVEL=debug|info|warn|error|silent` (case-insensitive; `silent` or `off`
omits both log flags entirely). Unknown values fall back to `INFO` with a stderr warning.

Or run individual steps:

```sh
bun run check    # typecheck + Biome (lint & format)
bun run test     # unit & integration tests
bun run test:vp  # unit tests via vp (parallel, cached)
bun run format   # auto-format with Biome
bun run lint     # lint with Biome
```

Treat partial local checks as progress, not as release completion. If a defect affects the reusable reference surfaces or host packages,
fix it in `agents-js` before narrowing it to any host-specific consumer.

Run a single package's tests:

```sh
bun test packages/validation
bun test packages/acp
```

## Commit Conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation only
- `style:` formatting (no logic change)
- `refactor:` code restructuring
- `test:` adding or updating tests
- `tooling:` build, CI, or tooling changes

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `bun run ci`, `bun run docs:build`, and any relevant `e2e:*` proof-surface checks
4. If the work intentionally changes release posture, update the relevant docs in the same PR
5. Open a PR with a clear description of what changed and why

## Code Conventions

### Named imports and exports at package boundaries

Every import and export that crosses a package boundary must name its bindings explicitly.

**Forbidden at package boundaries:**

- `export * from "@agents-js/<other-package>"` — wildcard barrel re-exports of other first-party packages.
  These couple the re-exporting package's version lifecycle to the target's and silently bridge
  symbol renames across first-party package surfaces.
- `import * as Namespace from "@agents-js/<other-package>"` — wildcard namespace imports against
  first-party packages. If a symbol rename lands upstream, a namespace import silently skips the
  symbol with no type-checker feedback.

**Permitted:**

- `export * from "./relative/path.ts"` — in-package barrels.
- `export * from "@ag-ui/core"` / `export * from "@a2ui/web_core/v0_9"` — external facade re-exports
  where we intentionally re-surface a third-party namespace as a stable `@agents-js/*` entry point.
  These are whitelisted by name in `tests/package-barrel-imports.test.ts`.
- `import { symbol } from "@agents-js/<other-package>"` — named imports. Default.

Enforcement lives in `tests/package-barrel-imports.test.ts` and runs as part of `bun run test`. The
check covers `packages/*/src/index.ts` for re-exports and `packages/**/src/**` for namespace imports.

## Security Reports

Do not file public issues for vulnerabilities. Follow [SECURITY.md](SECURITY.md).
