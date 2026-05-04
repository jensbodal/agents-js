---
title: Contribute
---

# Contribute

This page covers everything contributors and operators need to work inside the `agents-js` monorepo: development setup, build and test commands, release posture, the release checklist, and deploying docs from local.

If you are trying to use the product first, start with [Getting Started](/getting-started), [Browser Guide](/surfaces), or [CLI Guide](/surfaces#cli).

For browser-safe package export conventions, see [Browser Entry Points](/develop/browser-entry-points).

## Development Setup

```sh
mise install       # provision bun
bun run setup      # install deps + doctor + build
bun run setup --runtime claude
bun run dev        # source-linked gateway + web UI
bun run browser:smoke  # canonical mock browser proof
bun run e2e:web:live -- --runtime claude  # real runtime + browser e2e
```

`bun run dev` prints `Gateway URL`, `Gateway WS URL`, `Web UI URL`, and the canonical `Open URL`.
Use the printed `Open URL` for the integrated browser proof path.

To serve with a specific runtime:

```sh
vp run @agents-js/cli#serve -- --harness claude
vp run @agents-js/cli#serve -- --harness opencode --profile clean-room
```

Connect the TUI client:

```sh
vp run @agents-js/cli#client -- --url http://127.0.0.1:<printed-port>
```

## Tooling

### Root Commands

```sh
bun run setup          # install dependencies, run doctor for the default runtime, and build tracked outputs
bun run setup --runtime claude
bun run dev            # run doctor, start the gateway, wait for the card, then start the web UI
bun run build          # output-aware cached rebuild
bun run test           # run all tests
bun run check          # release-surface audit + typecheck + biome check
bun run lint           # biome lint
bun run format         # biome format --write
bun run e2e:gateway    # deterministic gateway proof
bun run browser:smoke  # canonical mock browser proof with isolated Playwright
bun run e2e:runtime -- --runtime claude
bun run e2e:web:live -- --runtime claude
bun run e2e:deterministic
bun run e2e -- --runtime claude
bun run ci             # deterministic upstream proof gate
bun run test:docs      # TypeDoc code-block validation
bun run docs:verify-generated  # fail if generated API docs drift from checked-in docs/api
bun run release:preflight  # full local release/distribution contract audit
```

### How It Works

- **vp** (vite-plus) owns the canonical root task graph in `vite.config.ts`
- root `bun run ...` commands are thin wrappers around root `vp run -w repo:*` tasks
- **build** is output-aware: if tracked build artifacts exist, it uses `vp` script caching; if any are missing, it forces an uncached rebuild so replayed logs never leave missing `dist/` outputs behind
- **dev** is source-linked: runtime entrypoints resolve workspace packages from `src`, not `dist`
- **biome** handles linting and formatting
- **bun test** runs tests natively
- **mise** provisions the toolchain (`bun = "latest"` in `mise.toml`)

### Canonical VP Tasks

```sh
vp run -w repo:doctor
vp run -w repo:build
vp run -w repo:dev
vp run -w repo:dev:gateway
vp run -w repo:dev:web
vp run --no-cache -w repo:browser:smoke
vp run --no-cache -w repo:e2e:gateway
vp run --no-cache -w repo:e2e:runtime
vp run --no-cache -w repo:e2e:web:live
vp run --no-cache -w repo:e2e:deterministic
vp run --no-cache -w repo:e2e
```

### Per-Package Commands

Target any package script directly:

```sh
vp run @agents-js/cli#serve              # start the operator gateway
vp run @agents-js/cli#client             # open the TUI client
vp run @agents-js/web-ui#dev             # web UI dev server only
vp run --cache @agents-js/cli#build      # cached single-package build
vp run @agents-js/validation#generate:acp  # regenerate ACP schema
```

Or use bun directly:

```sh
bun run --cwd packages/cli serve
bun test packages/acp
bun test packages/validation
```

List all available tasks:

```sh
vp run    # prints every package script in the workspace
```

### Build

`bun run build` uses the repo-owned build launcher. If all tracked outputs already exist, it runs a cached recursive `vp` build. If any tracked output is missing, it forces an uncached recursive rebuild so package script cache replay cannot mask missing artifacts.

Tracked outputs include package `dist/` entrypoints, the compiled CLI binary, and the web app production build.

## Release Posture

### Versioning and Scope

All publishable package `package.json` files ship on one beta train. Patch increments ship as work lands.

Everything documented in this site is in the release claim. Bugs get fixed in the next patch. There are no per-package tier labels (Stable / RC / Preview / Experimental). The single status is **beta**.

The publication gate: a patch should not ship with an unacknowledged regression in the declared beta workflow. See [Beta Contract](/beta-contract) for the canonical contract definition and [Package Map](/primitives#package-map) for the per-package list.

### Canonical Proof Surfaces

The release-defining validation surface for `agents-js` is repo-local:

| Surface | Scope | Why it matters |
|---------|-------|----------------|
| `apps/web-ui` | Browser reference client | Proves the browser-side UX and host bridge from source. |
| `apps/internal-gateway` | Runtime and ACP/A2A bridge | Proves runtime boot, gateway behavior, and repo-owned live flows. |
| Package tests | Unit + integration | Prove reusable contracts package by package. |
| Docs build + docs deploy tooling | Public docs surface | Proves that the published docs site matches the checked-in story. |

External consumers can still be useful corroborating evidence, but they are not the canonical release gate for this repo.

### Managed Branch Flow

`agents-js` is the long-lived reviewed integration lane for this repo. Keep the managed worktree on `agents-js`, push that branch for branch-local validation, and only promote `main` by fast-forwarding it to the exact validated `agents-js` tip.

If `origin/main` moves before promotion, rebase `agents-js` onto `origin/main`, rerun the required local gates, push the rebased `agents-js` branch, and only then fast-forward `main`. Do not use merge commits or ad hoc release branches between the two lanes.

### Release Operator Contract

`bun run release:preflight` is the authoritative machine-checked release audit. It verifies the publishable package set, shared release version, internal exact-version `@agents-js/*` cross-pins, `publishConfig.registry`, `publishConfig.access`, dependency publish order, and the repo-root scoped `.npmrc` entry without printing auth material.

`scripts/publish-all.ts` runs the same audit before any publish attempt. Its dry-run also verifies `npm pack --json --dry-run` for every publishable package, so a green publish dry-run proves the packed tarball surface includes the built `dist/` outputs and matches the manifest metadata.

### Docs Publication Contract

The repository builds static docs with VitePress. Deployment topology is
operator-owned: CI systems, registries, tunnels, reverse proxies, and container
orchestration are configured outside the package contract.

### Consumption Guidance

| Method | When to Use | How |
|--------|-------------|-----|
| `file:` links | Active co-development with a sibling checkout | `"@agents-js/acp": "file:../../agents-js/packages/acp"` |
| `bun pack` tarball | Smoke testing from an isolated consumer | `bun pack` in the package dir, then `bun add ./agents-js-acp-0.2.0.tgz` |
| npm-compatible registry | Package publication | `npm publish --tag beta` through `scripts/publish-all.ts` |

**Known limitation:** direct local-directory installs can still fail when a package depends on other unpublished `@agents-js/*` packages. Use `file:` links for co-development or packed tarballs plus `overrides` for isolated smoke installs.

### Per-Package Quality Bar

Every publishable package is expected to clear:

- all package tests pass
- at least one integration test exercises the package
- API surface is documented
- the repo-owned proof surface covers the package's main contract
- the Browser and CLI/reference-host flows stay green
- docs, publish scripts, and release operator guidance remain aligned with shipped behavior

These are the working expectations, not gates that promote a package between tiers.


## Release statement

The user-facing release statement is the [Beta Contract](/beta-contract).
