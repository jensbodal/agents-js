---
name: strict-no-antitrigger
description: Perform strict-mode checks against a skill that has plenty of content but no anti-trigger clause. This description is deliberately padded to cross the 300-character lower bound while leaving the Not-for segment absent so the validator focuses solely on the missing anti-trigger rule. It includes use-when triggers and enough substance to look convincing at first glance.
---

# Strict No Anti-Trigger

This fixture exercises the anti-trigger branch of the strict validator.

## When NOT to Use

- happy-path strict tests — use strict-ok

Padding body content to exceed 200 chars so the body-length check passes
and the failing rule is isolated to the missing anti-trigger clause.
