# ACP runtime logging-flags audit

Companion audit for the `AJS_RUNTIME_LOG_LEVEL` contract currently wired
into the opencode profile only. Session 3 deferred covering
`claude-agent-acp` and `gemini --acp`; this note captures today's
investigation and open questions so they can be picked up without
re-doing the legwork.

## Current state

`packages/gateway-runtime/src/runtimes.ts:resolveRuntimeArgs` reads
`AJS_RUNTIME_LOG_LEVEL` and appends `--print-logs --log-level <LEVEL>`
for the `opencode` runtime definition only. Non-opencode runtimes get
their `definition.args` passed through unchanged. The envelope env-var
(`AJS_RUNTIME_LOG_LEVEL`) is advertised as a runtime-agnostic contract
via `packages/gateway-runtime/src/runtime-env-overrides.ts`, but today
only opencode honors it.

Uniform semantics across runtimes would mean: the same env var flips
log level for any ACP agent the gateway drives, regardless of which
binary backs it.

## Binaries probed

### `claude-agent-acp`

- Binary present at `/Users/jensbodal/local/bun/bin/claude-agent-acp`.
- `claude-agent-acp --help` returns **empty stdout** and exit code 0.
  Confirmed at time of audit (2026-04-17). This is consistent with the
  prior Session 3 observation — claude-agent-acp has never shipped a
  documented `--help` surface.
- No documented `--log-level`, `--verbose`, or `--debug` flag on the
  CLI. Reading the published sources confirms the binary is a small
  stdin/stdout JSON-RPC transport wrapper around `@anthropic-ai/sdk`;
  logging is controlled by the upstream SDK's own environment
  contract, not by a CLI flag.
- `ANTHROPIC_LOG=debug` (SDK-owned env var) is the closest thing to a
  runtime-level log flip for claude-agent-acp. Standalone observation:
  this env var surfaces SDK-level HTTP diagnostics on stderr when set.
  It is an Anthropic SDK contract, not an ACP-layer contract.
- **Open question:** do we want to map `AJS_RUNTIME_LOG_LEVEL=debug`
  onto `ANTHROPIC_LOG=debug` under the claude-agent-acp profile? That
  mixes log domains (ACP envelope vs SDK HTTP traffic) and could leak
  request bodies containing workspace paths, so it should not be
  silent. A defensible policy: only export `ANTHROPIC_LOG=debug` when
  `AJS_RUNTIME_LOG_LEVEL=debug` is set explicitly, and log a one-shot
  warn on the gateway stderr noting that Anthropic SDK diagnostics are
  now on. Do not escalate `info`/`warn` levels to anything — they map
  to silence for claude-agent-acp.

### `gemini --acp`

- Binary present at
  `/Users/jensbodal/.local/share/mise/installs/node/24.15.0/bin/gemini`
  (v0.38.1 at time of audit).
- `gemini --help` output is NOT empty (verified: full Commander/yargs
  help tree is emitted). Relevant flags for logging / verbosity:
  - `-d, --debug` — "Run in debug mode (open debug console with F12)".
    This opens a TUI-era debug console, not a stderr log stream. Not a
    CLI-level log-level knob usable from a non-interactive ACP runtime.
  - `--acp` / `--experimental-acp` — boolean, enables ACP mode. No
    sub-flags documented.
- There is no `--log-level`, `--verbose`, or `--quiet` flag on gemini.
- Gemini's own env contract reads `GEMINI_DEBUG` (not documented in
  `--help` but referenced in various upstream issues) and
  `CLOUDSDK_VERBOSITY` for gcloud-style Google Cloud SDK layer. Neither
  is ACP-specific.
- **Open question:** do we want to map `AJS_RUNTIME_LOG_LEVEL=debug`
  onto `GEMINI_DEBUG=1` for the gemini profile? Same caveat as
  Anthropic: this flips gemini's internal debug wiring, not an
  ACP-layer logger. The upstream behavior is undocumented, which is
  fragile. Safer path: leave gemini as pass-through until either
  Google documents a stable log surface or a user reports a concrete
  diagnostic need.

## Recommendation

Do not extend `resolveRuntimeArgs` to either claude-agent-acp or gemini
based on what is documented today. The right shape for the next change
is additive env-var pass-through, not CLI-flag injection:

1. For claude-agent-acp: optionally (and only on
   `AJS_RUNTIME_LOG_LEVEL=debug`) export `ANTHROPIC_LOG=debug` through
   the runtime's env map, with a stderr warn about request-body
   visibility. Stop there.
2. For gemini: skip. File the upstream documentation gap via an issue
   once the gateway's uniform log contract actually starts shipping
   observed-broken symptoms for gemini-backed sessions.

Either path requires reshaping `resolveRuntimeArgs` to also return an
env-var patch, or adding a parallel `resolveRuntimeEnv` helper. That is
a small API change and should land alongside the first consumer, not
in isolation.

## Status

Audit only. No code change this commit. Claude-agent-acp's `--help`
returning empty stdout confirms Session 3's notes; gemini's help
renders but documents no ACP-level log flag. The work remains "ship
env-var pass-through once a concrete need surfaces".

## References

- Flag wiring today: `packages/gateway-runtime/src/runtimes.ts` around
  `resolveRuntimeArgs` and `resolveOpencodeLogFlags`.
- Envelope contract: `packages/gateway-runtime/src/runtime-env-overrides.ts`.
- Originating tracker (now removed): backlog item
  `audit-claude-agent-acp-and-gemini-acp-for-logging-flags-and-wire-into-runtime-profiles`.
  This doc is the tracker.
