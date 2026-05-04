import { describe, expect, test } from "bun:test";
import { adaptTarget, type RawAgentCard } from "@agents-js/a2a-client";
import { agentZeroAdapter } from "./agent-zero.ts";

const BASE_RAW_CARD: RawAgentCard = {
  name: "agent-zero",
  description: "Agent Zero AI assistant",
  url: "http://localhost:8000",
  version: "1.0.0",
  protocolVersion: "0.3.0",
  skills: [],
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  capabilities: {},
};

function makeFetch(
  card: RawAgentCard,
  status = 200,
): (input: string | Request | URL, init?: RequestInit) => Promise<Response> {
  return async () =>
    new Response(JSON.stringify(card), {
      status,
      headers: { "content-type": "application/json" },
    });
}

describe("agentZeroAdapter", () => {
  describe("probePath", () => {
    test("uses /.well-known/agent.json (not agent-card.json)", () => {
      const adapter = agentZeroAdapter({ externalUrl: "https://az.example.com" });
      expect(adapter.probePath).toBe("/.well-known/agent.json");
      expect(adapter.probePath).not.toBe("/.well-known/agent-card.json");
    });
  });

  describe("authHeader", () => {
    test("returns Bearer token when token is provided", () => {
      const adapter = agentZeroAdapter({
        externalUrl: "https://az.example.com",
        token: "my-secret",
      });
      const header = adapter.authHeader?.({ externalUrl: "https://az.example.com", probeUrl: "" });
      expect(header).toBe("Bearer my-secret");
    });

    test("returns null when no token is provided", () => {
      const adapter = agentZeroAdapter({ externalUrl: "https://az.example.com" });
      const header = adapter.authHeader?.({ externalUrl: "https://az.example.com", probeUrl: "" });
      expect(header).toBeNull();
    });

    test("authHeader hook is present on the adapter", () => {
      const adapter = agentZeroAdapter({ externalUrl: "https://az.example.com" });
      expect(typeof adapter.authHeader).toBe("function");
    });
  });

  describe("transformCard: URL rewrite", () => {
    test("replaces http://localhost:8000 with externalUrl", async () => {
      const adapter = agentZeroAdapter({ externalUrl: "https://az.example.com" });
      const result = await adaptTarget(adapter, "https://az.example.com", {
        fetch: makeFetch(BASE_RAW_CARD),
      });
      expect(result.card.url).toBe("https://az.example.com");
    });

    test("does not rewrite url when it is not localhost:8000", async () => {
      const cardWithCustomUrl: RawAgentCard = {
        ...BASE_RAW_CARD,
        url: "https://already-external.example.com",
      };
      const adapter = agentZeroAdapter({ externalUrl: "https://az.example.com" });
      const result = await adaptTarget(adapter, "https://az.example.com", {
        fetch: makeFetch(cardWithCustomUrl),
      });
      // Non-localhost URL passes through unchanged
      expect(result.card.url).toBe("https://already-external.example.com");
    });
  });

  describe("transformCard: A2A-compatible card shape", () => {
    test("produces a valid AgentCard with all required fields", async () => {
      const adapter = agentZeroAdapter({ externalUrl: "https://az.example.com" });
      const result = await adaptTarget(adapter, "https://az.example.com", {
        fetch: makeFetch(BASE_RAW_CARD),
      });
      const card = result.card;
      expect(typeof card.name).toBe("string");
      expect(typeof card.description).toBe("string");
      expect(typeof card.url).toBe("string");
      expect(typeof card.version).toBe("string");
      expect(typeof card.protocolVersion).toBe("string");
      expect(Array.isArray(card.skills)).toBe(true);
      expect(Array.isArray(card.defaultInputModes)).toBe(true);
      expect(Array.isArray(card.defaultOutputModes)).toBe(true);
    });

    test("preserves name and description from raw card", async () => {
      const adapter = agentZeroAdapter({ externalUrl: "https://az.example.com" });
      const result = await adaptTarget(adapter, "https://az.example.com", {
        fetch: makeFetch(BASE_RAW_CARD),
      });
      expect(result.card.name).toBe("agent-zero");
      expect(result.card.description).toBe("Agent Zero AI assistant");
    });

    test("fills defaults when raw card omits optional fields", async () => {
      const minimalCard: RawAgentCard = {
        url: "http://localhost:8000",
      };
      const adapter = agentZeroAdapter({ externalUrl: "https://az.example.com" });
      const result = await adaptTarget(adapter, "https://az.example.com", {
        fetch: makeFetch(minimalCard),
      });
      expect(result.card.name).toBe("agent-zero");
      expect(result.card.protocolVersion).toBe("0.3.0");
      expect(result.card.defaultInputModes).toEqual(["text"]);
      expect(result.card.defaultOutputModes).toEqual(["text"]);
    });
  });

  describe("full integration: adaptTarget with agentZeroAdapter", () => {
    test("end-to-end: probe at agent.json, auth header applied, URL rewritten", async () => {
      let capturedUrl = "";
      let capturedAuthHeader = "";

      const adapter = agentZeroAdapter({
        externalUrl: "https://az.example.com",
        token: "e2e-token",
      });

      const result = await adaptTarget(adapter, "https://az.example.com", {
        fetch: async (input, init) => {
          capturedUrl = input as string;
          const headers = init?.headers as Record<string, string> | undefined;
          capturedAuthHeader = headers?.Authorization ?? "";
          return new Response(JSON.stringify(BASE_RAW_CARD), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });

      expect(capturedUrl).toBe("https://az.example.com/.well-known/agent.json");
      expect(capturedAuthHeader).toBe("Bearer e2e-token");
      expect(result.card.url).toBe("https://az.example.com");
      expect(result.authHeader).toBe("Bearer e2e-token");
    });
  });
});
