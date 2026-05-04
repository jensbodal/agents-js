---
name: strict-weak-verb
description: This skill starts with a pronoun instead of an action verb, which strict-mode should flag. Despite the weak opener, the rest of the description still has enough content to cross the length floor and includes a Not for clause so only the opening-word check should fail in isolation. This padding keeps us comfortably in the target length band for the description.
---

# Strict Weak Verb

Fixture to isolate the action-verb opener check.

## When NOT to Use

- happy-path strict tests

Enough body padding to keep the body-length check passing while the
description-opener check is the single failing strict-mode rule.
