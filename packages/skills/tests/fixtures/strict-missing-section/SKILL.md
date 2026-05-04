---
name: strict-missing-section
description: Perform strict-mode checks on a skill whose body omits the When NOT to Use section. Everything else about the body is fine, the description is long enough, opens with an action verb, and includes a Not for anti-trigger. The one failure this fixture isolates is the missing When-NOT-to-Use heading which is the single most commonly skipped authoring convention.
---

# Strict Missing Section

Fixture that isolates the missing-section strict-mode rule.

## Purpose

Exercise the body-section check in isolation so tests can assert the
expected error message without noise from other rules.

## When to Use

- isolating the missing-section rule
- regression guards against accidental rule relaxation
