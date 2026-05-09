import { describe, expect, test } from "bun:test";
import {
  ACP_AUTH_REQUIRED_METADATA_KEY,
  ACP_ELICITATION_RESPONSE_METADATA_KEY,
} from "@agents-js/validation";
import {
  buildACPA2AContinuationMetadata,
  buildACPA2ATaskMetadata,
  extractACPA2AContinuationMetadata,
} from "../src/acp-task-metadata.ts";

// These three functions form the auth + elicitation round-trip across the
// A2A wire: buildACPA2A*Metadata → JSON over the network → extract on the
// other side. If round-trip breaks, auth and elicitation flows silently
// fail in production. Pin the contract.

describe("buildACPA2ATaskMetadata — authRequired", () => {
  test("emits authMethods + message when methods are present", () => {
    const md = buildACPA2ATaskMetadata({
      authRequired: {
        authMethods: [{ id: "chatgpt", name: "ChatGPT", description: "Login with ChatGPT" }],
        message: "Please log in.",
      },
    });
    expect(md[ACP_AUTH_REQUIRED_METADATA_KEY]).toEqual({
      kind: "acp.auth-required",
      authMethods: [{ id: "chatgpt", name: "ChatGPT", description: "Login with ChatGPT" }],
      message: "Please log in.",
    });
  });

  test("omits authMethods when the array is empty", () => {
    const md = buildACPA2ATaskMetadata({
      authRequired: { authMethods: [], message: "msg" },
    });
    const entry = md[ACP_AUTH_REQUIRED_METADATA_KEY] as Record<string, unknown>;
    expect(entry).not.toHaveProperty("authMethods");
    expect(entry.message).toBe("msg");
  });

  test("supplies a default message when none is provided", () => {
    const md = buildACPA2ATaskMetadata({
      authRequired: { authMethods: [{ id: "x", name: "X", description: "x" }] },
    });
    const entry = md[ACP_AUTH_REQUIRED_METADATA_KEY] as Record<string, unknown>;
    expect(typeof entry.message).toBe("string");
    expect((entry.message as string).length).toBeGreaterThan(0);
  });

  test("returns an empty object when no payload is given", () => {
    expect(buildACPA2ATaskMetadata({})).toEqual({});
  });
});

describe("authenticate continuation — round-trip", () => {
  test("methodId survives build → extract", () => {
    const built = buildACPA2AContinuationMetadata({
      authenticate: { methodId: "chatgpt" },
    });
    const extracted = extractACPA2AContinuationMetadata(built);
    expect(extracted?.authenticate).toEqual({ methodId: "chatgpt" });
  });

  test("returns undefined when methodId is absent on the wire", () => {
    // build without methodId emits the kind marker but no methodId
    const built = buildACPA2AContinuationMetadata({
      authenticate: { methodId: undefined as unknown as string },
    });
    expect(extractACPA2AContinuationMetadata(built)).toBeUndefined();
  });
});

describe("elicitation-response continuation — round-trip", () => {
  test("accept + content survives build → extract", () => {
    const built = buildACPA2AContinuationMetadata({
      elicitationResponse: {
        action: "accept",
        content: { username: "ada" },
      },
    });
    const extracted = extractACPA2AContinuationMetadata(built);
    expect(extracted?.elicitationResponse).toEqual({
      action: "accept",
      content: { username: "ada" },
    });
  });

  test("accept without content survives build → extract", () => {
    const built = buildACPA2AContinuationMetadata({
      elicitationResponse: { action: "accept" },
    });
    const extracted = extractACPA2AContinuationMetadata(built);
    expect(extracted?.elicitationResponse).toEqual({ action: "accept" });
  });

  test("reject survives build → extract and drops content", () => {
    const built = buildACPA2AContinuationMetadata({
      elicitationResponse: { action: "decline" },
    });
    const extracted = extractACPA2AContinuationMetadata(built);
    expect(extracted?.elicitationResponse).toEqual({ action: "decline" });
  });

  test("cancel survives build → extract", () => {
    const built = buildACPA2AContinuationMetadata({
      elicitationResponse: { action: "cancel" },
    });
    const extracted = extractACPA2AContinuationMetadata(built);
    expect(extracted?.elicitationResponse).toEqual({ action: "cancel" });
  });
});

describe("extractACPA2AContinuationMetadata", () => {
  test("returns undefined for non-object input", () => {
    expect(extractACPA2AContinuationMetadata(null)).toBeUndefined();
    expect(extractACPA2AContinuationMetadata("string")).toBeUndefined();
    expect(extractACPA2AContinuationMetadata([1, 2])).toBeUndefined();
  });

  test("returns undefined when no relevant keys are present", () => {
    expect(extractACPA2AContinuationMetadata({ unrelated: 1 })).toBeUndefined();
  });

  test("combines authenticate and elicitationResponse on the same envelope", () => {
    const md = {
      ...buildACPA2AContinuationMetadata({ authenticate: { methodId: "chatgpt" } }),
      ...buildACPA2AContinuationMetadata({
        elicitationResponse: { action: "accept", content: { x: 1 } },
      }),
    };
    const extracted = extractACPA2AContinuationMetadata(md);
    expect(extracted?.authenticate).toEqual({ methodId: "chatgpt" });
    expect(extracted?.elicitationResponse).toEqual({
      action: "accept",
      content: { x: 1 },
    });
  });

  test("ignores malformed elicitation entries silently", () => {
    const md = {
      [ACP_ELICITATION_RESPONSE_METADATA_KEY]: { not: "shaped right" },
    };
    expect(extractACPA2AContinuationMetadata(md)).toBeUndefined();
  });
});
