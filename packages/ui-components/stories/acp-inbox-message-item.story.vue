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

// AJS-88 / DOT-502 v0.2 — bridge-fanout row. `kind: "matrix_room_mention"`
// surfaces the small "matrix" badge in the header; the matrix_origin
// envelope round-trips through the InboxMessageLike type but is not
// rendered (consumers use it for correlation, not display).
const matrixFanout: InboxMessageLike = {
  message_id: "msg-fanout-1",
  from_session: "@user:matrix.example",
  to_session: "ajs-claude",
  created_at: "2026-05-26T14:50:00.000Z",
  body: "@ajs-claude please ack the latest spec revision when you get a moment",
  kind: "matrix_room_mention",
  matrix_origin: {
    event_id: "$evt-fanout-1:matrix.example",
    room_id: "!coord-room:matrix.example",
    sender: "@user:matrix.example",
    origin_server_ts: 1748263800000,
  },
};

// AJS-88 / DOT-502 v0.2 — bridge-fanout row + threaded reply.
// `matrix_origin.reply_to_event_id` is present; the type layer carries
// it for downstream correlation without re-deriving from body text.
const matrixFanoutReply: InboxMessageLike = {
  message_id: "msg-fanout-2",
  from_session: "@user:matrix.example",
  to_session: "ajs-claude",
  created_at: "2026-05-26T14:52:00.000Z",
  body: "@ajs-claude reply-thread: that PR landed on gitea, see #142",
  kind: "matrix_room_mention",
  matrix_origin: {
    event_id: "$evt-fanout-2:matrix.example",
    room_id: "!coord-room:matrix.example",
    sender: "@user:matrix.example",
    origin_server_ts: 1748263920000,
    reply_to_event_id: "$evt-fanout-1:matrix.example",
  },
};

// AJS-88 / DOT-502 v0.2 — high-priority bridge-fanout row. Both badges
// render in the header; the kind badge precedes the priority badge.
const matrixFanoutHighPriority: InboxMessageLike = {
  message_id: "msg-fanout-3",
  from_session: "@oncall:matrix.example",
  to_session: "ajs-claude",
  created_at: "2026-05-26T14:55:00.000Z",
  body: "@ajs-claude URGENT — gateway crash loop on LXC189, escalation handle",
  priority: "high",
  kind: "matrix_room_mention",
  matrix_origin: {
    event_id: "$evt-fanout-3:matrix.example",
    room_id: "!ops-room:matrix.example",
    sender: "@oncall:matrix.example",
    origin_server_ts: 1748264100000,
  },
};

// Pre-contract / native-send row: `kind` explicitly "agents_message"
// renders identically to the legacy plain row (no badge). Pinned as a
// variant to make the back-compat invariant visually inspectable.
const explicitAgentsMessage: InboxMessageLike = {
  message_id: "msg-native-1",
  from_session: "cognee-claude",
  to_session: "ajs-claude",
  created_at: "2026-05-26T14:58:00.000Z",
  body: "Native agents.send_message — kind field set but no badge surfaces.",
  kind: "agents_message",
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

    <Variant title="bridge-fanout (kind = matrix_room_mention)">
      <acp-inbox-message-item :message="matrixFanout" />
    </Variant>

    <Variant title="bridge-fanout + threaded reply (matrix_origin.reply_to_event_id)">
      <acp-inbox-message-item :message="matrixFanoutReply" />
    </Variant>

    <Variant title="bridge-fanout + high priority (both badges)">
      <acp-inbox-message-item :message="matrixFanoutHighPriority" />
    </Variant>

    <Variant title="explicit kind = agents_message (no badge — back-compat)">
      <acp-inbox-message-item :message="explicitAgentsMessage" />
    </Variant>
  </Story>
</template>
