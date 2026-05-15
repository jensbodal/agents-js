<script setup lang="ts">
import { onMounted, ref } from "vue";

interface ElicitationSchema {
  title?: string;
  description?: string;
  properties?: Record<string, unknown>;
  required?: string[];
}

const defaultSchema: ElicitationSchema = {
  title: "Deployment Config",
  description: "Configure how the new build should ship.",
  properties: {
    environment: {
      type: "string",
      title: "Environment",
      enum: ["staging", "production"],
    },
    confirmShip: {
      type: "boolean",
      title: "Confirm I want to ship",
    },
    notes: {
      type: "string",
      title: "Notes",
      description: "Optional commentary for the release log.",
    },
  },
  required: ["environment", "confirmShip"],
};

const validationSchema: ElicitationSchema = {
  title: "Deployment Config",
  description: "Two required fields; Accept will be clicked on mount to surface validation errors.",
  properties: {
    environment: {
      type: "string",
      title: "Environment",
      enum: ["staging", "production"],
    },
    confirmShip: {
      type: "boolean",
      title: "Confirm I want to ship",
    },
  },
  required: ["environment", "confirmShip"],
};

const longSchema: ElicitationSchema = {
  title: "User Profile",
  description: "Multi-field form exercising text, number, enum, and boolean inputs.",
  properties: {
    fullName: { type: "string", title: "Full name" },
    age: { type: "number", title: "Age" },
    tier: {
      type: "string",
      title: "Account tier",
      enum: ["free", "pro", "enterprise"],
    },
    optIn: {
      type: "boolean",
      title: "Subscribe to release updates",
    },
    notes: { type: "string", title: "Bio" },
  },
  required: ["fullName", "tier"],
};

const validationFormRef = ref<HTMLElement | null>(null);

onMounted(() => {
  // Trigger Accept on the validation-error variant after mount so the form
  // populates its `_errors` state. This is a real component code path, not
  // a faked state injection.
  queueMicrotask(() => {
    const el = validationFormRef.value;
    if (!el) return;
    const acceptBtn = el.shadowRoot?.querySelector<HTMLButtonElement>(".btn-accept");
    acceptBtn?.click();
  });
});
</script>

<template>
  <Story title="Surfaces / Elicitation Form">
    <Variant title="Default — mixed field types">
      <acp-elicitation-form
        message="The agent needs configuration to proceed."
        :schema="defaultSchema"
      />
    </Variant>

    <Variant title="Validation errors (Accept clicked on mount)">
      <acp-elicitation-form
        ref="validationFormRef"
        message="Validation surfaces required-field errors after Accept."
        :schema="validationSchema"
      />
    </Variant>

    <Variant title="Long form — many fields">
      <acp-elicitation-form
        message="Full profile capture."
        :schema="longSchema"
      />
    </Variant>

    <Variant title="No message header (schema-only)">
      <acp-elicitation-form :schema="defaultSchema" />
    </Variant>
  </Story>
</template>
