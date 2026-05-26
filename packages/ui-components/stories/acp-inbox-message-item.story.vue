<script setup lang="ts">
import type { InboxMessageLike } from "../src/acp-inbox-message-item.ts";

const plain: InboxMessageLike = {
  message_id: "msg-plain-1",
  from_session: "alice",
  to_session: "ajs-claude",
  created_at: "2026-05-26T14:32:00.000Z",
  body: "Quick status check — are you available for the inbox surface review?",
};

const highPriority: InboxMessageLike = {
  message_id: "msg-priority-1",
  from_session: "operator",
  to_session: "ajs-claude",
  created_at: "2026-05-26T14:35:00.000Z",
  body: "URGENT: gateway restart required, see ops channel.",
  priority: "high",
};

const lowPriority: InboxMessageLike = {
  message_id: "msg-low-1",
  from_session: "noise-bot",
  to_session: "ajs-claude",
  created_at: "2026-05-26T14:36:00.000Z",
  body: "FYI: nightly digest ready.",
  priority: "low",
};

const multilineBody: InboxMessageLike = {
  message_id: "msg-multi-1",
  from_session: "cognee-claude",
  to_session: "ajs-claude",
  created_at: "2026-05-26T14:40:00.000Z",
  body: [
    "Architecture-lane review on the inbox browser:",
    "",
    "1. Substrate distinction is captured cleanly.",
    "2. Phase 2 sequencing on AJS-58 holds.",
    "3. Phase 3 discriminator filter is additive.",
  ].join("\n"),
};

const longBody: InboxMessageLike = {
  message_id: "msg-long-1",
  from_session: "long-message-sender-with-an-unusually-long-identifier",
  to_session: "ajs-claude",
  created_at: "2026-05-26T14:45:00.000Z",
  body:
    "This is a very long body that should wrap cleanly without overflowing the card boundary. " +
    "It also contains multiple sentences to exercise the line-height + word-break behavior. " +
    "The from_session identifier is intentionally long to test header layout under stress.",
};
</script>

<template>
  <Story title="Surfaces / Inbox Message Item">
    <Variant title="plain message (no priority)">
      <acp-inbox-message-item :message="plain" />
    </Variant>

    <Variant title="high priority">
      <acp-inbox-message-item :message="highPriority" />
    </Variant>

    <Variant title="low priority">
      <acp-inbox-message-item :message="lowPriority" />
    </Variant>

    <Variant title="multi-line body (newline preservation)">
      <acp-inbox-message-item :message="multilineBody" />
    </Variant>

    <Variant title="long body + long from_session (wrapping stress)">
      <acp-inbox-message-item :message="longBody" />
    </Variant>

    <Variant title="missing message (defensive empty)">
      <acp-inbox-message-item />
    </Variant>
  </Story>
</template>
