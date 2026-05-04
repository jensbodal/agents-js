# AGENTS.md

## Scope

- `agents-js` is the reusable ACP/A2A SDK plus the reference gateway and web UI surfaces.
- If a defect affects reusable SDK or reference-surface behavior, fix it here before narrowing it to a downstream consumer.

## Stack

- TypeScript + Bun workspace.
- Biome for linting and formatting.
- VitePress for docs.

## Working Rules

- **First-time setup on a fresh checkout: run `bun run setup`.** This sets `git config core.hooksPath .githooks` (so the pre-commit / pre-push hooks at `.githooks/` actually fire) and runs `bun scripts/build.ts` (so `dist/index.d.mts` is populated for every workspace package). Skipping this step puts the workspace in a half-bootstrapped state where commits silently bypass validation AND `bunx tsgo --noEmit` emits hundreds of `Cannot find module '@agents-js/*'` errors against the unbuilt source — both of which look like real problems but are pure setup omissions. See `mise.toml` for the cross-package resolution rationale.
- Use the narrowest available tool. Prefer repo-native commands and structured search/edit flows over broad generic shell usage when practical.
- Create git worktrees as siblings or in another separate directory outside this package checkout; never nest a worktree inside the package it is a worktree of.
- Commit incrementally on the current feature branch to save progress. Large refactors sequence into multiple commits; no single commit needs to encompass a full explore→plan→implement loop. A formal planning pass is helpful for multi-file refactors but is not a gate on committing a correct, typecheck-clean, formatted change. Merge-to-main and push-to-origin remain explicit user-directed ceremonies.
- Treat AI output as draft code. Read the full diff, check architecture/style fit, look for subtle bugs and security issues, and own the final result.
- For behavior changes, write or update targeted tests before or alongside implementation. Run the smallest proving command first, then widen only as needed.
- Keep comments intent-focused. Use names and structure for the obvious.
- Follow existing formatting, linting, and package-boundary conventions unless the current pattern is actively harmful.
- Keep sessions focused. Start fresh for unrelated tasks.
- **Before drafting any PR body, read `.github/pull_request_template.md` and use its H2 sections verbatim.** Do not improvise or omit sections. If a section doesn't apply, write `(none)` rather than deleting the heading. The template's sections are the contract reviewers expect — silently dropping "Protocol / compatibility notes" because the change "doesn't have any" is the most common drift, and it makes mechanical review harder for the next person.

## Proof Surfaces

- Pre-commit hook auto-formats (`bun run format`) and auto-fixes safe biome lint (`bunx biome check --write`) before running `bun run check`. Agents commit freely and only manually fix what the tooling cannot (real type errors, non-auto-fixable lint, failing tests).
- `bun run check` for preflight, typecheck, Biome, and generated-doc drift.
- `mise run ci` for the local pre-push gate.
- `bun run ci` for the full deterministic upstream gate.
- `bun run docs:build` when docs or generated API surfaces change.
- `bun run browser:smoke` for the canonical mock browser proof.
- `bun run e2e:runtime -- --runtime <runtime>` for real-runtime ACP/A2A proof.
- `bun run e2e:web:live -- --runtime <runtime>` for live browser E2E.

## Review Priorities

- Generated docs are load-bearing. Do not leave `docs/api` drift behind after API or docs-surface changes.
- Package-boundary rules are mandatory review points: no wildcard re-exports across first-party package boundaries and no first-party namespace imports across package boundaries; use named bindings explicitly.
- Keep reusable fixes in `agents-js` instead of burying them in downstream adapters or host-specific consumers.

## Trackers

- Do not suggest or create `backlog.json` or `roadmap.json` items by default.
- Use trackers only when the user explicitly asks, or when a non-blocking issue is discovered during active work and parking it prevents derailing the session.
- When parking a non-blocking issue, mention it briefly and ask before mutating tracker files.
