import { describe, expect, test } from "bun:test";
import {
  normalizeAgentTargetInput,
  normalizeHeaders,
  originCardFallback,
  summarizeCapabilities,
} from "../src/index.ts";
import { makeAgentCard } from "./mock-a2a-transport.ts";

describe("a2a-client target helpers", () => {
  test("normalizes a base URL input", () => {
    const target = normalizeAgentTargetInput({
      url: "127.0.0.1:55363/",
    });

    expect(target.baseUrl).toBe("http://127.0.0.1:55363");
    expect(target.cardUrl).toBe("http://127.0.0.1:55363/.well-known/agent-card.json");
    expect(target.mode).toBe("base");
  });

  test("normalizes a full card URL input", () => {
    const target = normalizeAgentTargetInput({
      url: "http://127.0.0.1:55363/.well-known/agent-card.json",
    });

    expect(target.baseUrl).toBe("http://127.0.0.1:55363");
    expect(target.cardUrl).toBe("http://127.0.0.1:55363/.well-known/agent-card.json");
    expect(target.mode).toBe("card");
  });

  test("preserves nested base paths", () => {
    const target = normalizeAgentTargetInput({
      url: "http://127.0.0.1:55363/a2a/demo/.well-known/agent-card.json",
    });

    expect(target.baseUrl).toBe("http://127.0.0.1:55363/a2a/demo");
    expect(target.cardUrl).toBe("http://127.0.0.1:55363/a2a/demo/.well-known/agent-card.json");
  });

  test("preserves arbitrary full card URLs in card mode", () => {
    const target = normalizeAgentTargetInput({
      url: "https://example.com/agents/demo/custom-card.json",
      mode: "card",
    });

    expect(target.baseUrl).toBe("https://example.com/agents/demo");
    expect(target.cardUrl).toBe("https://example.com/agents/demo/custom-card.json");
    expect(target.clientFactoryUrl).toBe("https://example.com/agents/demo/custom-card.json");
    expect(target.clientFactoryPath).toBe("");
    expect(target.mode).toBe("card");
  });

  test("originCardFallback rewrites a sub-path URL to origin-level card", () => {
    const normalized = normalizeAgentTargetInput({ url: "http://127.0.0.1:55363/a2a" });
    expect(normalized.cardUrl).toBe("http://127.0.0.1:55363/a2a/.well-known/agent-card.json");

    const fallback = originCardFallback(normalized);
    expect(fallback).not.toBeNull();
    expect(fallback?.baseUrl).toBe("http://127.0.0.1:55363");
    expect(fallback?.cardUrl).toBe("http://127.0.0.1:55363/.well-known/agent-card.json");
    expect(fallback?.clientFactoryUrl).toBe("http://127.0.0.1:55363");
    expect(fallback?.mode).toBe("base");
  });

  test("originCardFallback returns null when URL already targets origin", () => {
    const normalized = normalizeAgentTargetInput({ url: "http://127.0.0.1:55363" });
    expect(originCardFallback(normalized)).toBeNull();
  });

  test("originCardFallback returns null for card-mode inputs", () => {
    const normalized = normalizeAgentTargetInput({
      url: "http://127.0.0.1:55363/a2a/.well-known/agent-card.json",
    });
    expect(normalized.mode).toBe("card");
    expect(originCardFallback(normalized)).toBeNull();
  });

  test("normalizes headers by trimming empty values", () => {
    expect(
      normalizeHeaders({
        " x-api-key ": " secret ",
        empty: "   ",
      }),
    ).toEqual({
      "x-api-key": "secret",
    });
  });

  test("summarizes capabilities from an agent card", () => {
    const summary = summarizeCapabilities(
      makeAgentCard({
        name: "agent",
        description: "desc",
        defaultInputModes: ["text"],
        defaultOutputModes: ["text/plain"],
        capabilities: { streaming: true, pushNotifications: false },
      }),
    );

    expect(summary.supportsTextInput).toBe(true);
    expect(summary.supportsTextOutput).toBe(true);
    expect(summary.supportsStreaming).toBe(true);
    expect(summary.supportsPushNotifications).toBe(false);
  });
});
