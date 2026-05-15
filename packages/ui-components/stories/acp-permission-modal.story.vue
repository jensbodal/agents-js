<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { PermissionRequestLike } from "../src/acp-types.ts";

// Mounted refs for variants that need post-mount DOM manipulation.
const rawInputModalRef = ref<HTMLElement | null>(null);

const baseRequest: PermissionRequestLike = {
  toolCall: {
    title: "write_file",
  },
  message: "The agent wants to write to `~/.config/agents-js/settings.json`.",
  options: [
    {
      optionId: "allow_once",
      kind: "allow_once",
      name: "Allow once",
      description: "Approve this single write only.",
    },
    {
      optionId: "allow_always",
      kind: "allow_always",
      name: "Allow always",
      description: "Approve all writes to this path.",
    },
    {
      optionId: "deny",
      kind: "deny",
      name: "Deny",
    },
  ],
};

const allowOnlyRequest: PermissionRequestLike = {
  toolCall: { title: "read_file" },
  message: "The agent wants to read `package.json`.",
  options: [
    {
      optionId: "allow_once",
      kind: "allow_once",
      name: "Allow",
    },
  ],
};

const denyEmphasisRequest: PermissionRequestLike = {
  toolCall: { title: "execute_shell" },
  message: "The agent wants to run `rm -rf node_modules`. This action is destructive.",
  options: [
    {
      optionId: "deny",
      kind: "deny",
      name: "Deny",
      description: "Block this command.",
    },
  ],
};

const scopeRequest: PermissionRequestLike = {
  toolCall: { title: "write_file" },
  message: "The agent wants to write to `~/projects/agents-js/docs/index.md`.",
  options: [
    { optionId: "allow_once", kind: "allow_once", name: "Allow" },
    { optionId: "deny", kind: "deny", name: "Deny" },
  ],
  suggestedScopes: [
    { level: "file", scope: "/Users/me/projects/agents-js/docs/index.md", label: "Just this file" },
    { level: "directory", scope: "/Users/me/projects/agents-js/docs", label: "Everything under docs/" },
    { level: "project", scope: "/Users/me/projects/agents-js", label: "The whole project" },
  ],
};

const rawInputRequest: PermissionRequestLike = {
  toolCall: {
    title: "fetch",
    rawInput: {
      url: "https://api.example.com/users",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { name: "alice", role: "admin" },
    },
  },
  message: "The agent wants to make an HTTP request.",
  options: [
    { optionId: "allow_once", kind: "allow_once", name: "Allow" },
    { optionId: "deny", kind: "deny", name: "Deny" },
  ],
};

// Expand the raw-input panel after mount so the story shows the expanded state.
onMounted(() => {
  // Defer to next tick so Lit's render has settled.
  queueMicrotask(() => {
    const el = rawInputModalRef.value;
    if (!el) return;
    const toggle = el.shadowRoot?.querySelector<HTMLButtonElement>(".toggle-raw");
    toggle?.click();
  });
});
</script>

<template>
  <Story title="Surfaces / Permission Modal">
    <Variant title="Default — allow / always / deny">
      <acp-permission-modal :request="baseRequest" />
    </Variant>

    <Variant title="Allow-only (single option)">
      <acp-permission-modal :request="allowOnlyRequest" />
    </Variant>

    <Variant title="Deny-emphasis (destructive action)">
      <acp-permission-modal :request="denyEmphasisRequest" />
    </Variant>

    <Variant title="Scope picker (multiple suggested scopes)">
      <acp-permission-modal :request="scopeRequest" />
    </Variant>

    <Variant title="Raw input expanded">
      <acp-permission-modal ref="rawInputModalRef" :request="rawInputRequest" />
    </Variant>
  </Story>
</template>
