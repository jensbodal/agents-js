import { expect, test } from "bun:test";
import type { InitializeResponse } from "@agents-js/acp";
import {
  buildAgentCard,
  CURRENT_A2A_PROTOCOL_VERSION,
  type GatewayAgentCapabilities,
  type GatewayAgentCard,
  type HarnessCapabilityEntry,
  mapCapabilities,
} from "../src/index.ts";

/** A2A 1.0 moved the bind URL into `supportedInterfaces[].url`. */
function cardUrl(card: GatewayAgentCard): string | undefined {
  return card.supportedInterfaces[0]?.url;
}

function createAgentCard() {
  return buildAgentCard({ name: "test", description: "Gateway test card" });
}

test("buildAgentCard: fills required defaults for minimal input", () => {
  const card = buildAgentCard({
    name: "gateway",
    description: "Gateway test agent",
  });

  expect(cardUrl(card)).toBe("http://127.0.0.1");
  expect(card.supportedInterfaces[0]?.protocolVersion).toBe(CURRENT_A2A_PROTOCOL_VERSION);
  expect(card.version).toBe("1.0.0");
  expect(card.skills).toEqual([]);
  expect(card.defaultInputModes).toEqual(["text"]);
  expect(card.defaultOutputModes).toEqual(["text"]);
  expect(card.capabilities).toEqual({ extensions: [] });
});

test("buildAgentCard: preserves caller overrides", () => {
  const card = buildAgentCard({
    name: "gateway",
    description: "Gateway test agent",
    supportedInterfaces: [
      {
        url: "https://example.com/agent-card.json",
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
      },
    ],
    version: "2.0.0",
    defaultInputModes: ["application/json"],
    capabilities: { extensions: [], "text-to-text": { enabled: true } },
  });

  expect(cardUrl(card)).toBe("https://example.com/agent-card.json");
  expect(card.version).toBe("2.0.0");
  expect(card.defaultInputModes).toEqual(["application/json"]);
  expect(card.capabilities["text-to-text"]).toEqual({ enabled: true });
});

test("mapCapabilities: maps multimodal capability from agentCapabilities", () => {
  const acpInfo: InitializeResponse = {
    protocolVersion: 1,
    agentCapabilities: {
      promptCapabilities: { image: true },
    },
  };
  const card = createAgentCard();
  const capabilities: GatewayAgentCapabilities = card.capabilities;

  mapCapabilities(acpInfo, card);
  expect(capabilities.multimodal).toBe(true);
  expect(capabilities.streaming).toBe(true);
});

test("mapCapabilities: maps resources and prompts", () => {
  const acpInfo: InitializeResponse = { protocolVersion: 1 };
  const card = createAgentCard();
  const capabilities: GatewayAgentCapabilities = card.capabilities;
  const resources = [{ uri: "file://test", name: "test file" }];
  const prompts = [{ name: "test-prompt", description: "a test prompt" }];

  mapCapabilities(acpInfo, card, resources, prompts);
  expect(capabilities.resources).toHaveLength(1);
  expect(capabilities.resources?.[0]?.uri).toBe("file://test");
  expect(capabilities.prompts).toHaveLength(1);
  expect(capabilities.prompts?.[0]?.name).toBe("test-prompt");
});

test("buildAgentCard: omits harnesses capability unless explicitly added", () => {
  const card = buildAgentCard({
    name: "gateway",
    description: "Gateway test agent",
  });

  expect("harnesses" in card.capabilities).toBe(false);
  expect(card.capabilities.harnesses).toBeUndefined();
});

test("GatewayAgentCard: JSON round-trip preserves harnesses entries", () => {
  const card: GatewayAgentCard = buildAgentCard({
    name: "universal-acp-gateway",
    description: "Multi-harness gateway",
  });
  const harnesses: HarnessCapabilityEntry[] = [
    { id: "opencode", displayName: "OpenCode ACP", primary: true, ready: true },
    { id: "gemini", displayName: "Gemini ACP", primary: false, ready: false },
  ];
  card.capabilities.harnesses = harnesses;

  const roundTripped = JSON.parse(JSON.stringify(card)) as GatewayAgentCard;

  expect(roundTripped.capabilities.harnesses).toHaveLength(2);
  expect(roundTripped.capabilities.harnesses?.[0]).toEqual({
    id: "opencode",
    displayName: "OpenCode ACP",
    primary: true,
    ready: true,
  });
  expect(roundTripped.capabilities.harnesses?.[1]).toEqual({
    id: "gemini",
    displayName: "Gemini ACP",
    primary: false,
    ready: false,
  });
});

test("HarnessCapabilityEntry: type-checks well-formed entries; rejects malformed ones", () => {
  const valid: HarnessCapabilityEntry = {
    id: "opencode",
    displayName: "OpenCode ACP",
    primary: true,
    ready: true,
  };
  expect(valid.id).toBe("opencode");

  // @ts-expect-error — missing required field `ready`
  const missingField: HarnessCapabilityEntry = {
    id: "opencode",
    displayName: "OpenCode ACP",
    primary: true,
  };
  expect(missingField.id).toBe("opencode");

  const wrongType: HarnessCapabilityEntry = {
    id: "opencode",
    displayName: "OpenCode ACP",
    // @ts-expect-error — `primary` must be boolean, not string
    primary: "yes",
    ready: true,
  };
  expect(wrongType.id).toBe("opencode");
});
