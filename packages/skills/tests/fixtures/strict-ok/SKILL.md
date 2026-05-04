---
name: strict-ok
description: Perform strict-mode conformance checks against a well-formed skill by asserting description length, anti-triggers, action-verb opener, body length, When-NOT-to-Use section, and H1 title, then roll the findings into a single ValidationResult for downstream reporting. Use when asked to verify strict-mode parity, check authoring conventions, or gate a skill before publish. Not for tolerant-mode validation (use validateSkill), not for MCP integration, not for runtime execution (out of scope for this package).
---

# Strict OK Fixture

This fixture passes every strict-mode rule. It exists so tests can assert
the happy path of the strict validator without false-negative drift.

## Purpose

Exercise the passing branch of every strict-mode check.

## When to Use

- happy-path tests for strict mode
- regression guards against accidental rule tightening
- documentation examples of what a good skill looks like

## When NOT to Use

- exercising tolerant-mode failure paths — use the malformed fixtures
- exercising runtime failures — use the load.test fixtures

## Workflow

1. Parse the fixture.
2. Load via loadSkill.
3. Pass it to the strict validator and assert valid is true.
