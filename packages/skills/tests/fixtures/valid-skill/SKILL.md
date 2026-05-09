---
name: valid-skill
description: Perform a representative operation on inputs, produce structured outputs, and serve as a fixture for parse and validate tests. Covers a full range of tolerant-mode checks. Use when asked to test validation against a well-formed skill, exercise the loader, or verify registry round-tripping. Not for strict-mode authoring-convention checks (use strict-mode-examples fixtures instead).
license: MIT
allowed-tools:
  - Read
  - Write
aliases: [valid, fixture-ok]
---

# Valid Skill

This is a fixture skill used by the test suite. Its body contains enough
content to satisfy tolerant-mode body-non-empty checks.

## Purpose

Exercise happy-path validation and loading paths.
