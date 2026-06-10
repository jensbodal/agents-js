---
title: Shared Utilities & Parsing
---

# Shared Utilities & Parsing

This page is the **navigation index for reusable surfaces** in the monorepo — the
parsers, validators, and normalizers you should reach for *before* hand-rolling.
It exists because the same brittle parsing was independently reimplemented in
several packages: the fix is not just deleting the duplicates, it is making the
canonical surface discoverable so the duplication does not recur.

If you are about to write `something.split(/\s+/)`, a one-off regex to detect a
structural/security condition, or yet another `parseArgs`, stop and check this
page first.

## Canonical parsers

| Need | Reach for | Where |
| --- | --- | --- |
| **CLI argument parsing** | `parseArgv<TArgs>()` + composable `ArgSpec` fragments (`hostPortArgs`, `harnessArg`, `runtimeSelectArgs`, …) | `packages/cli/src/argv-parser.ts`, `packages/cli/src/shared-arg-specs.ts` |
| **Gateway CLI/env args** | `parseCliArgs()`, and `parseGatewayPort()` / `normalizeGatewayPublicUrl()` for validated port/URL | `apps/internal-gateway/cli-args.ts`, `apps/internal-gateway/discovery.ts` |
| **Wire / payload validation** | Zod + JSON-Schema validators (`validateACPEnvelope`, `validateAgentCard`, `validateWireAgentRegistryRecord`, `validateJsonRpcEnvelope`) | `packages/validation` |
| **Schema → field metadata** | `toFieldMetas()`, `extractOneOf()` | `packages/schema-utils` |

The `cli` table-driven parser is the reference pattern: each flag is an `ArgSpec`
entry with an `assign` callback that validates on assignment, so parsing is
idempotent and order-independent. Validation logic lives in `validation` as Zod
schemas — the canonical source of truth for every wire shape. **Do not** detect
a payload's validity by string inspection; run it through the schema.

## Canonical normalizers

Reuse these instead of re-deriving the same normalization:

| Normalizer | Purpose | Where |
| --- | --- | --- |
| `normalizeAgentName` | strip invisible/ZWJ Unicode from agent names | `packages/acp-host` (`agent-name-normalize.ts`) |
| `normalizePermissionMode`, `normalizeSessionModes` | coerce to strict enums | `packages/acp-host` |
| `normalizeHeaders` | case-insensitive header dedup (last-wins) | `packages/a2a-client` (`target.ts`) |
| `normalizeAgentTargetInput` | canonical A2A target (URL, headers, capabilities) | `packages/a2a-client` |
| `parseAgentMentions`, `parseDispatchDirective`, `stripMention` | `@mention` / `@@dispatch` parsing | `packages/a2a-client` (`mention-parser.ts`) |
| `normalizeAdvertisedHost`, `buildAgentCardBaseUrl` | canonical advertised host / card URL | `packages/a2a` (`server.ts`) |
| `normalizeInboxKind` | validate/normalize inbox kind to enum | `packages/host` (`agents-tool-surface.ts`) |
| `replyTargetForRow`, `resolveReplyTarget` | **security**: distinguish native entity names from Matrix origins (prevents mxid/room-id route-injection) | `packages/gateway-inbox-runtime` (`reply-routing.ts`) |
| `isWithinWorkspace`, `closestParentFolder` | workspace boundary checks | `packages/policy` (`path-utils.ts`) |

> Note: `parseDispatchDirective` currently exists in **two** places with subtly
> different contracts — the strict alphanumeric-dash version in `a2a-client` and a
> looser one in `host/matrix-bus-consumer.ts`. Prefer the `a2a-client` contract
> for agent dispatch. Consolidation is tracked.

## Shell-argument tokenization (the gap)

There is **no shared quote-safe shell-argument tokenizer** yet, which is why
several packages hand-roll `value.trim().split(/\s+/)`. That split is wrong: it
breaks on any quoted value containing spaces (`--flag "a b"` → `["--flag", "\"a",
"b\""]`).

**Do not add another `split(/\s+/)` to turn a flag string into argv.** A shared
tokenizer is being introduced; until it lands, if you must split, leave a comment
explaining the quoting assumption and add a test, or require the config to supply
a pre-split JSON array instead of a flag string.

Known sites awaiting migration to the shared tokenizer:
`agent-launch/src/plan.ts` (`splitFlags`), `claude-channel-adapter/bin/launcher.ts`
(MCP args fallback), `tools/src/primitives/sigil-registry.ts` (`extractArgs`),
`policy/src/permission-engine.ts` (`extractShellCommandPathArgs` — security-adjacent),
`extras/reporting/src/cli.ts`.

## RegEx policy

RegEx should **rarely** be used. When it is, it must be:

1. **Unit tested** — including the edge inputs it is meant to reject.
2. **Commented** — say *why* a regex (vs. a real parse) and *what* it matches.

Never use a regex (or a string scan) as the sole gate for a **security or
structural** condition when a real parse/normalize exists — normalize the value
into a typed form and decide on that. Good examples to follow: the documented +
tested `@mention` patterns in `a2a-client/src/mention-parser.ts`, and the RFC-4648
base64 validation in `host/src/ed25519.ts`.

## How to navigate

- Each package re-exports its public surface through its barrel `index.ts` — skim
  that first to see what a package offers.
- `packages/validation` is the home for canonical wire/payload validators.
- `packages/cli/src/shared-arg-specs.ts` is the home for reusable CLI flag specs.
- This page is the index; when you add a broadly reusable parser/validator/
  normalizer, add a row here so the next contributor finds it.

## Appendix: audit findings (2026-06-10)

A repo-wide sweep catalogued the brittle-parsing sites this page exists to
prevent. Each is tracked for remediation; the canonical fixes are a shared
shell-arg tokenizer and reuse of the surfaces above.

| Severity | Site | Pattern |
| --- | --- | --- |
| high | `scripts/process-utils.ts` (pgrep output) | uncommented `split(/\s+/)` |
| high | `apps/internal-gateway/main.ts` (`AGENTS_JS_SYNC_INTERVAL_MS`) | unvalidated `Number(env)` → NaN/Infinity |
| med | `agent-launch/src/plan.ts` `splitFlags` | naive shell-arg `split(/\s+/)` |
| med | `claude-channel-adapter/bin/launcher.ts` | MCP-args `split(/\s+/)` fallback |
| med | `tools/src/primitives/sigil-registry.ts` `extractArgs` | naive shell-arg `split(/\s+/)` |
| med | `policy/src/permission-engine.ts` `extractShellCommandPathArgs` | shell-arg `split(/\s+/)` (security-adjacent path checks) |
| med | `extras/reporting/src/cli.ts` | hand-rolled `parseArgs` |

Duplicated logic tracked for consolidation: shell-operator split
(`agent-launch/identity.ts` + `matrix-agent-uniqueness.ts`), `buildExtendedPath`
(`acp-host` + `gateway-runtime`), `parseDispatchDirective` (`a2a-client` +
`host`), NDJSON line buffer (`extras/pi-acp` + `extras/droid-acp`), HMAC verify
(`extras/gitea-bridge` + `extras/plane`).
