---
name: strict-short-desc
description: Perform a thing. Not for other things.
---

# Strict Short Desc

Body content sufficient in length for the body-length strict check but
whose description is intentionally far below the 300-char floor. This
fixture ensures the strict validator reports the length error.

## When NOT to Use

- tolerant-mode failure paths

Additional padding so the body is >= 200 chars for the body-length check,
keeping the focus of this fixture on the description-length failure.
