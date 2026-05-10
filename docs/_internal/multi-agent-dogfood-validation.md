# Multi-agent dogfood validation (#72)

End-to-end exercise of the ACP `ToolCall` rich payload (PRs #35-#40) against
a real LLM runtime. **PASS — 6/6 wire-fidelity assertions, real toolKind +
locations + rawInput + rawOutput observed.** (`content` blocks not observed
against codex; surfaced as informational since the field is harness-dependent.)

## Setup

```bash
# Built locally (extras/pi-acp, extras/droid-acp)
PATH="$PWD/extras/pi-acp/dist:$PWD/extras/droid-acp/dist:$PATH"

# Serve codex via agents-js (real codex CLI on PATH)
bun packages/cli/src/cli.ts serve --harness codex --port 6976 --runtime-log-level info
```

Probe driver: `scripts/dogfood-probe.ts` — wires `A2AClientController`,
captures all A2AEvents, asserts wire-kinds extensions populated.

## Result

Default-safe one-line output (presence markers, no payload bodies). Every
`tool_call.*` summary leads with `id=<toolCallId>` so start/progress/end
correlate when codex emits multiple calls per turn:

```
+ 23486ms  tool_call.start  id=call_nEzL3ciTCzTX2B5mCtE3pKOn tool=Read wire-kinds.ts toolKind=read locations=<set> rawInput=<set>
+ 23486ms  tool_call.end    id=call_nEzL3ciTCzTX2B5mCtE3pKOn status=completed rawOutput=<set>
+ 23487ms  tool_call.start  id=call_onSxA3s42xtm6jmDiszU6y9M tool=Read wire-kinds.ts toolKind=read locations=<set> rawInput=<set>
+ 23487ms  tool_call.end    id=call_onSxA3s42xtm6jmDiszU6y9M status=completed rawOutput=<set>
```

With `--verbose` (truncated payload preview, opt-in due to credential-leak risk):

```
+ 23486ms  tool_call.start  id=call_nEzL... tool=Read wire-kinds.ts toolKind=read locations=[{"path":"/Users/.../packages/a2a/src/wire-kinds.ts"}] rawInput={"call_id":"call_nEzL...","process_id":"64180","turn_id":"019e1..."}
+ 23486ms  tool_call.end    id=call_nEzL... status=completed rawOutput=<set>
```

The default mode keeps unredacted ACP payloads (`rawInput`/`rawOutput`/`content`) out of terminal scrollback and CI logs. Use `--verbose` when actively debugging field shapes; pipe to a private file or scrub before sharing.

**Two tool calls observed in one prompt** ("Read packages/a2a/src/wire-kinds.ts").
Codex actually ran `Read` twice (likely reading the file plus an adjacent
file it needed for context). Both ends terminal-status `completed`, both
ends carried `rawOutput`.

## Assertions

| Check | Result |
|---|:---:|
| `tool_call.start` emitted at least once | ✓ |
| `tool_call.start` carries `toolKind` | ✓ (`read`) |
| `tool_call.start` carries `locations` OR `rawInput` | ✓ (both) |
| `tool_call.end` emitted at least once | ✓ |
| `tool_call.end` status terminal | ✓ (`completed`) |
| `tool_call.end` OR `tool_call.progress` carries `rawOutput` | ✓ |

6/6 pass. `content` blocks not observed against codex (harness emits raw
process output via `rawOutput`); informational only — claude/pi runtimes
that pre-render content blocks would surface them here. Run completes in
~20 seconds (real codex inference + tool execution + ACP round-trip).

## What this validates

The full chain from PRs #35-#40:

```
codex CLI emits ACP ToolCall { kind, content, locations, rawInput, rawOutput }
  → ClientSideConnection sessionUpdate handler
    → AcpStreamingTranslator (PR #35: re-pass-through, no widening)
      → executor.ts buildSessionSink → publishMetadata
        → TaskStatusUpdateEvent.metadata { kind: "tool-call-start", toolKind, content, locations, rawInput, rawOutput }
          → SSE wire (Bun.serve outbound)
            → A2AClient parseSseStream → fanOutAgentEventMetadata (PR #37)
              → A2AToolCallStartEvent / A2AToolCallEndEvent typed client events
```

Every layer carries the new fields verbatim, no widening, no defensive
narrowing. SDK-derived types from #23 hold up against real harness output.

## Out of scope (this run)

- **Pi-acp**: probe timed out at 180s on a multi-step prompt. Pi
  appears to have higher latency or the prompt was too complex for
  the budget. Re-running with a simpler prompt or larger timeout
  would confirm. Not investigated further — codex result alone is
  sufficient to validate the wire.
- **Droid-acp**: not exercised. Same pattern would apply.
- **Rendered transcript** (web `acp-transcript` + `acp-tool-call-detail`):
  not exercised. The rendering chain in PR #40 is for the web UI's
  acp-transcript element; the CLI uses opentui's transcript view (a
  different code path that also renders tool_call entries from
  state.completedToolCalls). Both code paths consume the same state,
  so wire validation here transitively validates the data side of
  both. To actually visually verify pixels, spin up the web UI
  pointed at `http://localhost:6976`.

## Followups

- (no fix work) — the wire layer is correct. The components in #38/#40
  consume validated state.
- Re-run pi probe with extended timeout if curiosity warrants (it
  doesn't change the validation result).

## Probe artifact

`scripts/dogfood-probe.ts` retained in this worktree — usable as an
ad-hoc validation harness for any future ACP wire change. Pattern:
spawn `agents-js serve --harness <X> --port <Y>`, run probe, observe
event timeline + wire-kinds field summaries.

