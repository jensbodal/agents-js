import { expect, test } from "bun:test";
import type { InitializeResponse } from "@agents-js/acp";
import {
  buildAgentCard,
  CURRENT_A2A_PROTOCOL_VERSION,
  type GatewayAgentCapabilities,
  mapCapabilities,
} from "../src/index.ts";

function createAgentCard() {
  return buildAgentCard({ name: "test", description: "Gateway test card" });
}

test("buildAgentCard: fills required defaults for minimal input", () => {
  const card = buildAgentCard({
    name: "gateway",
    description: "Gateway test agent",
  });

  expect(card.url).toBe("http://127.0.0.1");
  expect(card.version).toBe("1.0.0");
  expect(card.protocolVersion).toBe(CURRENT_A2A_PROTOCOL_VERSION);
  expect(card.skills).toEqual([]);
  expect(card.defaultInputModes).toEqual(["text"]);
  expect(card.defaultOutputModes).toEqual(["text"]);
  expect(card.capabilities).toEqual({});
});

test("buildAgentCard: preserves caller overrides", () => {
  const card = buildAgentCard({
    name: "gateway",
    description: "Gateway test agent",
    url: "https://example.com/agent-card.json",
    version: "2.0.0",
    defaultInputModes: ["application/json"],
    capabilities: { "text-to-text": { enabled: true } },
  });

  expect(card.url).toBe("https://example.com/agent-card.json");
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
