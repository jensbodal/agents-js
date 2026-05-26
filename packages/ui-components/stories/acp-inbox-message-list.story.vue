<script setup lang="ts">
import type { InboxMessageLike } from "../src/acp-inbox-message-item.ts";

const sample: InboxMessageLike[] = [
  {
    message_id: "msg-1",
    from_session: "alice",
    to_session: "ajs-claude",
    created_at: "2026-05-26T14:32:00.000Z",
    body: "Quick status check — are you available for the inbox surface review?",
  },
  {
    message_id: "msg-2",
    from_session: "operator",
    to_session: "ajs-claude",
    created_at: "2026-05-26T14:35:00.000Z",
    body: "URGENT: gateway restart required, see ops channel.",
    priority: "high",
  },
  {
    message_id: "msg-3",
    from_session: "cognee-claude",
    to_session: "ajs-claude",
    created_at: "2026-05-26T14:40:00.000Z",
    body: "Architecture-lane review on AJS-85 Phase 1 — approved, see PR thread.",
  },
  {
    message_id: "msg-4",
    from_session: "noise-bot",
    to_session: "ajs-claude",
    created_at: "2026-05-26T14:42:00.000Z",
    body: "FYI: nightly digest ready (3 items).",
    priority: "low",
  },
  {
    message_id: "msg-5",
    from_session: "alice",
    to_session: "ajs-claude",
    created_at: "2026-05-26T14:50:00.000Z",
    body: "Follow-up: thanks for the review, will iterate.",
  },
];
</script>

<template>
  <Story title="Surfaces / Inbox Message List">
    <Variant title="populated (5 messages)">
      <acp-inbox-message-list
        heading="ajs-claude inbox"
        subtitle="self-session view · 5 of 5"
        :messages="sample"
      />
    </Variant>

    <Variant title="empty (no messages)">
      <acp-inbox-message-list
        heading="ajs-claude inbox"
        subtitle="self-session view · 0 of 0"
        :messages="[]"
      />
    </Variant>

    <Variant title="loading">
      <acp-inbox-message-list
        heading="ajs-claude inbox"
        subtitle="self-session view"
        :messages="[]"
        loading
      />
    </Variant>

    <Variant title="error banner">
      <acp-inbox-message-list
        heading="ajs-claude inbox"
        subtitle="self-session view"
        :messages="sample"
        error-message="scope-not-granted: caller lacks inbox.read"
      />
    </Variant>

    <Variant title="single message">
      <acp-inbox-message-list
        heading="ajs-claude inbox"
        subtitle="self-session view · 1 of 1"
        :messages="[sample[0]!]"
      />
    </Variant>
  </Story>
</template>
