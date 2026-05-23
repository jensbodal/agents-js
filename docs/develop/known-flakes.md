---
title: Known flakes & same-flake-merge policy
diataxis: reference
outline: [2, 3]
---

# Known flakes & same-flake-merge policy

## What this covers

This page documents test failures that are known to be environmental
(infrastructure, timing, runner state) rather than regressions in the
code under test, and codifies the policy for landing PRs whose CI is
red on a known flake.

The default release-engineering posture for `agents-js` is **green CI
is required before merge**. This page documents the narrow exception
to that default: an agent-decidable admin-merge bypass when a known
flake's fingerprint has occurred at least twice on PRs whose code
changes are unrelated to the failing surface.

## Same-flake-merge policy

When a PR's CI is red on a known-flake fingerprint (see [Known
flakes](#known-flakes)) and the PR's code changes do not touch the
failing surface, the author MAY admin-merge after recording the
bypass in the PR body. Concretely:

1. **N ≥ 2 occurrences.** The flake must have failed on at least two
   independent PRs (different code changes, different commits) within
   a rolling 14-day window. The first occurrence is logged as a
   one-off; only the second occurrence opens the bypass.
2. **Unrelated code surface.** The PR's diff must not touch the
   package, test file, or runtime under test that the failing assertion
   exercises. A PR that modifies the same package as the flake source
   is presumed related until proven otherwise; bypass requires a
   reviewer's explicit "diff is unrelated" attestation.
3. **Bypass record.** The PR body MUST include a `Same-flake bypass`
   block listing:
   - Flake fingerprint (test name + failure shape)
   - Prior occurrences (PR numbers + commit shas + dates)
   - Justification ("diff is in package X; flake is in package Y test")
4. **Follow-up ticket.** If the rolling 14-day count reaches N ≥ 4,
   the flake escalates from "follow-up" to "sequencing blocker" and
   a Plane ticket MUST be filed (if one does not already exist) to
   investigate root cause before the next release cut.

This policy is **author-decidable**, not maintainer-gated. The intent
is to keep release velocity moving when infrastructure flakes
genuinely have no relationship to the code change. The intent is NOT
to bypass code review or flatten genuine regressions into "must be
flake." When uncertain, the right move is to retrigger CI and wait
for green, not to invoke the bypass.

External-repo merge policy (npm publish, github release PRs) is NOT
covered by this bypass. Bypass applies to gitea internal-repo merges
only.

## Known flakes

| Fingerprint | First seen | Last seen | Count | Status |
| ----------- | ---------- | --------- | ----- | ------ |
| A2A external-consumer-smoke 60s timeout (`scripts/sse-batching-against-agents-js.ts`) | 2026-05-12 | 2026-05-23 | 4 | Investigation queued; see [Investigation tickets](#investigation-tickets) below. |

### A2A external-consumer-smoke 60s timeout

The `external-consumer-smoke` gate spawns an external A2A client
against a freshly-spawned gateway and waits up to 60 s for the
expected SSE event stream to terminate cleanly. The flake surfaces
as a hard timeout at the 60 s mark with no diagnostic output beyond
the timeout itself; rerunning the same PR's CI without a code change
typically succeeds on the second attempt.

**What's been ruled out** (per `project_bun_serve_write_coalescing.md`
investigation):

- Bun.serve write-coalescing — symptom does not reproduce on current
  main when probed directly.
- undici fetch swap — tested and ruled out as the trigger surface.

**What remains hypothesized**:

- Runner-side load (gitea-actions runners are shared infrastructure).
- A genuine race condition in the gateway's SSE flush path that
  surfaces only under specific timing on the runner host.

The investigation is open as a follow-up; the bypass policy above
exists because the flake's failure shape is uncorrelated with the
PRs that hit it (4 separate PRs across the AJS-55 substrate arc, all
touching unrelated packages).

## Investigation tickets

- AJS-53 — original test failure context (`docs/develop/playground-smoke.md`
  has the playground equivalent gate).
- Plane task #124 — pending; investigate A2A external consumer smoke
  551 ms early-failure shape (new vs AJS-53 stale-lock).

## Recording a bypass — example PR body

```markdown
## Same-flake bypass

Fingerprint: A2A external-consumer-smoke 60s timeout
Prior occurrences:
  - PR #50 (commit 13142c27, 2026-05-19) — AJS-65 dispatcher refactor
  - PR #52 (commit 1dccf256, 2026-05-21) — docs drift gates
  - PR #54 (commit 8003b829, 2026-05-23) — AJS-55 substrate
Justification: this PR's diff is in `docs/federation/`; the failing
test exercises the SSE event stream from a real gateway spawned via
`scripts/sse-batching-against-agents-js.ts`. The diff cannot causally
affect the flake.
```

This shape is intentionally lightweight — three lines of context, no
ceremony. The point is to make the bypass auditable in `git log`
(commit message and PR body persist) rather than to gate it on a
heavy review process.

## Removing a flake from this page

A flake is removed from [Known flakes](#known-flakes) once either of
the following holds:

- A root-cause fix has landed and the fingerprint has not recurred
  for 30 days.
- The investigation closes "no actionable root cause, accept the
  flake as permanent" and the bypass is annotated as `permanent` in
  the table.

Permanent flakes still require the bypass record per [Same-flake-merge
policy](#same-flake-merge-policy); the only change is that the count
column is no longer tracked.
