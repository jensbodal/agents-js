<script setup lang="ts">
import type { CapabilityCardData } from "../src/acp-capability-card.ts";

const demonstrated: CapabilityCardData = {
  id: "federation-registry",
  title: "Federation / agent registry",
  tier: "demonstrated",
  packages: [
    { name: "@agents-js/gateway-runtime" },
    { name: "@agents-js/host" },
    { name: "@agents-js/a2a-client" },
  ],
  evidence: [
    {
      kind: "run",
      ref: "agents-js registry list",
      note: "Showed 3 live registered A2A gateways in ~/.agents-js/registry.json — real dogfooding state.",
    },
  ],
  notes: "Cross-gateway peer sync (--registry-sync) remains undemonstrated.",
};

const undemonstrated: CapabilityCardData = {
  id: "hardening",
  title: "Hardening track (signing / JWT / trust-manifest)",
  tier: "undemonstrated",
  packages: [{ name: "@agents-js/host" }],
  evidence: [
    {
      kind: "test",
      ref: "packages/host/src ed25519, mint-redeem-flow, load-trust-manifest",
      note: "10 impl files, tested; zero operator walkthrough.",
    },
  ],
  notes: "Gated behind AGENTS_MCP_JWT_SIGNING_KEY. Built, not aspirational — but invisible.",
};

const overClaimed: CapabilityCardData = {
  id: "browser-ux",
  title: "Browser/operator experience",
  tier: "over-claimed",
  packages: [{ name: "@agents-js/web-ui" }, { name: "@agents-js/gateway" }],
  evidence: [
    {
      kind: "doc",
      ref: "docs/getting-started.md",
      note: "Flagship 'bun run dev → Connect → Hello' path documented but never captured.",
    },
  ],
  notes: "browser-runtime docs meta-agent is prototype/experimental.",
};

const missing: CapabilityCardData = {
  id: "unified-profile",
  title: "Unified agent profile abstraction",
  tier: "missing",
  packages: [],
  evidence: [
    {
      kind: "doc",
      ref: "(no module)",
      note: "Grep confirms no profile abstraction package/module exists.",
    },
  ],
  notes: "0.7.0-class; no single harness+identity+channel surface.",
};

const minimal: CapabilityCardData = {
  id: "ag-ui",
  title: "AG-UI streaming transport",
  tier: "undemonstrated",
  packages: [{ name: "@agents-js/agui-types" }],
  evidence: [],
};
</script>

<template>
  <Story title="Surfaces / Capability Card">
    <Variant title="demonstrated (a human has seen it work)">
      <acp-capability-card :capability="demonstrated" />
    </Variant>

    <Variant title="undemonstrated (built + tested, not shown)">
      <acp-capability-card :capability="undemonstrated" />
    </Variant>

    <Variant title="over-claimed (docs assert more than exists)">
      <acp-capability-card :capability="overClaimed" />
    </Variant>

    <Variant title="missing (named but not built)">
      <acp-capability-card :capability="missing" />
    </Variant>

    <Variant title="minimal (no evidence, no notes)">
      <acp-capability-card :capability="minimal" />
    </Variant>

    <Variant title="grid (the ecosystem map MVP)">
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px;">
        <acp-capability-card :capability="demonstrated" />
        <acp-capability-card :capability="undemonstrated" />
        <acp-capability-card :capability="overClaimed" />
        <acp-capability-card :capability="missing" />
      </div>
    </Variant>
  </Story>
</template>
