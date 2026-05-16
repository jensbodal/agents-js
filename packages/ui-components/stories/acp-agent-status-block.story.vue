<script setup lang="ts">
import type { StatusSnapshotAgent } from "../src/agent-status-block-types.ts";

const onlineActive: StatusSnapshotAgent = {
  name: "cognee-claude",
  mxid: "@cognee-claude:matrix.q4m.dev",
  online: true,
  harness: "claude",
  workspace: "~/workspace/dot-cognee",
  transport: "tmux",
  tmux_session: "cognee-claude",
  pane_state: "attached",
  pane_detail: "prompt at bottom",
  activity_age_seconds: 12,
  deferred_messages: 0,
  gateway_url: "http://127.0.0.1:6701",
  gateway_healthy: true,
};

const onlineIdle: StatusSnapshotAgent = {
  name: "cognee-zai",
  mxid: "@cognee-zai:matrix.q4m.dev",
  online: true,
  harness: "zai",
  workspace: "~/workspace/dot-cognee",
  transport: "tmux",
  tmux_session: "cognee-zai",
  pane_state: "attached",
  pane_detail: "awaiting input",
  activity_age_seconds: 642,
  deferred_messages: 2,
  gateway_url: "http://127.0.0.1:6702",
  gateway_healthy: true,
};

const offlineRecent: StatusSnapshotAgent = {
  name: "cognee-kiro",
  mxid: "@cognee-kiro:matrix.q4m.dev",
  online: false,
  harness: "kiro",
  workspace: "~/workspace/dot-cognee",
  transport: "tmux",
  tmux_session: "cognee-kiro",
  pane_state: "detached",
  activity_age_seconds: 870,
  deferred_messages: 0,
};

const offlineStale: StatusSnapshotAgent = {
  name: "agent-zero-dev",
  mxid: "@agent-zero-dev:matrix.q4m.dev",
  online: false,
  harness: "agent-zero",
  workspace: "~/workspace/agent-zero",
  transport: "tmux",
  tmux_session: "agent-zero-dev",
  pane_state: "gone",
  activity_age_seconds: 14_400,
  deferred_messages: 7,
  gateway_url: "http://127.0.0.1:6710",
  gateway_healthy: false,
};

const minimalUnknown: StatusSnapshotAgent = {
  name: "newly-registered",
  mxid: "@newly-registered:matrix.q4m.dev",
  online: false,
};
</script>

<template>
  <Story title="Surfaces / Agent Status Block">
    <Variant title="online · active (recent activity)">
      <acp-agent-status-block :agent="onlineActive" />
    </Variant>

    <Variant title="online · idle (gap above threshold)">
      <acp-agent-status-block :agent="onlineIdle" />
    </Variant>

    <Variant title="offline · recent (within stale threshold)">
      <acp-agent-status-block :agent="offlineRecent" />
    </Variant>

    <Variant title="offline · stale (gateway unhealthy, deferred backlog)">
      <acp-agent-status-block :agent="offlineStale" />
    </Variant>

    <Variant title="minimal contract (most fields absent)">
      <acp-agent-status-block :agent="minimalUnknown" />
    </Variant>

    <Variant title="grid (multiple blocks side-by-side)">
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px;">
        <acp-agent-status-block :agent="onlineActive" />
        <acp-agent-status-block :agent="onlineIdle" />
        <acp-agent-status-block :agent="offlineRecent" />
        <acp-agent-status-block :agent="offlineStale" />
      </div>
    </Variant>
  </Story>
</template>
