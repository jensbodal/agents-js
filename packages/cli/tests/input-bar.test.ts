import { describe, expect, test } from "bun:test";
import type {
  A2ASessionState,
  ACPA2AElicitation,
  ACPA2AElicitationResponse,
} from "@agents-js/a2a-client";
import { createTestRenderer } from "@opentui/core/testing";
import { createClientInputBar } from "../src/client/ui/input-bar.ts";

function makeElicitationState(
  schema: ACPA2AElicitation["requestedSchema"],
  message = "Pick one",
): A2ASessionState {
  return {
    sessionId: "s1",
    transcript: [],
    status: "input_required",
    debugRecords: [],
    activeToolCalls: [],
    completedToolCalls: [],
    currentPlan: null,
    availableCommands: [],
    activeElicitation: {
      message,
      mode: "form",
      requestedSchema: schema,
    },
  };
}

describe("input-bar", () => {
  test("calls onSend with the submitted message", async () => {
    const { renderer } = await createTestRenderer({ width: 80, height: 4 });
    let sentMessage: string | undefined;

    const inputBar = createClientInputBar(renderer, async (message) => {
      sentMessage = message;
    });

    await inputBar.submit("Hello, agent!");
    expect(sentMessage).toBe("Hello, agent!");
  });

  test("submit does not reject when onSend throws (error logged to stderr)", async () => {
    const { renderer } = await createTestRenderer({ width: 80, height: 4 });
    let invoked = false;

    // Suppress stderr so the error log from the submit path doesn't
    // pollute test output. `submit` must still resolve — its caller is
    // the opentui keypress handler which has no upstream rejection path.
    const origWrite = process.stderr.write.bind(process.stderr);
    const stderrLines: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      const inputBar = createClientInputBar(renderer, async () => {
        invoked = true;
        throw new Error("boom");
      });

      await expect(inputBar.submit("hello")).resolves.toBeUndefined();
    } finally {
      process.stderr.write = origWrite;
    }

    expect(invoked).toBe(true);
    expect(stderrLines.some((l) => l.includes("submit callback failed: boom"))).toBe(true);
  });

  test("clears the rendered input immediately after enter", async () => {
    const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 40,
      height: 4,
    });

    let sentMessage: string | undefined;
    let resolveSend: (() => void) | undefined;
    const sendPromise = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });

    const inputBar = createClientInputBar(renderer, async (message) => {
      sentMessage = message;
      await sendPromise;
    });
    renderer.root.add(inputBar.root);
    inputBar.focus();

    await renderOnce();
    await mockInput.typeText("Hello");
    await renderOnce();

    const beforeSubmit = captureCharFrame();
    expect(beforeSubmit).toContain("Hello");

    mockInput.pressEnter();
    await renderOnce();

    const afterSubmit = captureCharFrame();
    expect(sentMessage).toBe("Hello");
    expect(afterSubmit).not.toContain("Hello");

    resolveSend?.();
  });

  test("does not submit empty/whitespace-only messages", async () => {
    const { renderer, mockInput, renderOnce } = await createTestRenderer({
      width: 40,
      height: 4,
    });

    let sendCalled = false;
    const inputBar = createClientInputBar(renderer, async () => {
      sendCalled = true;
    });
    renderer.root.add(inputBar.root);
    inputBar.focus();

    await renderOnce();
    await mockInput.typeText("   ");
    mockInput.pressEnter();
    await renderOnce();

    expect(sendCalled).toBe(false);
  });

  test("sends the raw value from ENTER event (whitespace preserved)", async () => {
    const { renderer, mockInput, renderOnce } = await createTestRenderer({
      width: 40,
      height: 4,
    });

    let sentMessage: string | undefined;
    const inputBar = createClientInputBar(renderer, async (message) => {
      sentMessage = message;
    });
    renderer.root.add(inputBar.root);
    inputBar.focus();

    await renderOnce();
    await mockInput.typeText("  hello  ");
    mockInput.pressEnter();
    await renderOnce();

    // ENTER handler passes raw value to submit; whitespace is preserved
    expect(sentMessage).toBe("  hello  ");
  });

  test("root exists and focus delegates without throwing", async () => {
    const { renderer } = await createTestRenderer({ width: 80, height: 4 });
    const inputBar = createClientInputBar(renderer, async () => {});

    // Root is a BoxRenderable container; focus delegates to internal input
    expect(inputBar.root).not.toBeUndefined();
    expect(() => inputBar.focus()).not.toThrow();
  });

  test("focus() delegates to the internal input without throwing", async () => {
    const { renderer } = await createTestRenderer({ width: 80, height: 4 });
    const inputBar = createClientInputBar(renderer, async () => {});

    // Should not throw — delegates to the InputRenderable child
    expect(() => inputBar.focus()).not.toThrow();
  });

  test("submit directly calls the onSend callback", async () => {
    const { renderer } = await createTestRenderer({ width: 80, height: 4 });
    const messages: string[] = [];

    const inputBar = createClientInputBar(renderer, async (msg) => {
      messages.push(msg);
    });

    await inputBar.submit("first");
    await inputBar.submit("second");

    expect(messages).toEqual(["first", "second"]);
  });

  test("multiple rapid sends are all delivered", async () => {
    const { renderer } = await createTestRenderer({ width: 80, height: 4 });
    const messages: string[] = [];

    const inputBar = createClientInputBar(renderer, async (msg) => {
      messages.push(msg);
    });

    await Promise.all([
      inputBar.submit("alpha"),
      inputBar.submit("beta"),
      inputBar.submit("gamma"),
    ]);

    expect(messages).toHaveLength(3);
    expect(messages).toContain("alpha");
    expect(messages).toContain("beta");
    expect(messages).toContain("gamma");
  });

  test("submit delivers messages through onSend callback", async () => {
    const { renderer } = await createTestRenderer({
      width: 60,
      height: 4,
    });
    const messages: string[] = [];
    const inputBar = createClientInputBar(renderer, async (msg) => {
      messages.push(msg);
    });

    await inputBar.submit("test message");
    expect(messages).toEqual(["test message"]);
  });
});

describe("input-bar oneOf support", () => {
  test("oneOf const values are used as enum options when enum is absent", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 4 });
    let response: ACPA2AElicitationResponse | undefined;

    const inputBar = createClientInputBar(renderer, {
      onAuthSelection: async () => {},
      onElicitationResponse: async (r) => {
        response = r;
      },
      onSend: async () => {},
    });

    inputBar.update(
      makeElicitationState({
        properties: {
          color: {
            type: "string",
            oneOf: [
              { const: "red", title: "Red" },
              { const: "blue", title: "Blue" },
            ],
          },
        },
        required: ["color"],
      }),
    );

    // Valid oneOf value should be accepted
    await inputBar.submit("red");
    expect(response).toEqual({ action: "accept", content: { color: "red" } });
  });

  test("oneOf rejects values not in const list", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 4 });
    let response: ACPA2AElicitationResponse | undefined;

    const inputBar = createClientInputBar(renderer, {
      onAuthSelection: async () => {},
      onElicitationResponse: async (r) => {
        response = r;
      },
      onSend: async () => {},
    });

    inputBar.update(
      makeElicitationState({
        properties: {
          color: {
            type: "string",
            oneOf: [
              { const: "red", title: "Red" },
              { const: "blue", title: "Blue" },
            ],
          },
        },
        required: ["color"],
      }),
    );

    // Invalid value should not produce a response (error is shown instead)
    await inputBar.submit("green");
    expect(response).toBeUndefined();
  });

  test("oneOf titles appear in the field prompt", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 200,
      height: 4,
    });

    const inputBar = createClientInputBar(renderer, {
      onAuthSelection: async () => {},
      onElicitationResponse: async () => {},
      onSend: async () => {},
    });
    renderer.root.add(inputBar.root);

    inputBar.update(
      makeElicitationState({
        properties: {
          model: {
            type: "string",
            oneOf: [
              { const: "gpt-4", title: "GPT-4" },
              { const: "claude", title: "Claude" },
            ],
          },
        },
      }),
    );

    await renderOnce();
    const frame = captureCharFrame();
    // Should show titled options like "gpt-4 (GPT-4), claude (Claude)"
    expect(frame).toContain("gpt-4 (GPT-4)");
    expect(frame).toContain("claude (Claude)");
  });

  test("enum takes precedence over oneOf when both are present", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 4 });
    let response: ACPA2AElicitationResponse | undefined;

    const inputBar = createClientInputBar(renderer, {
      onAuthSelection: async () => {},
      onElicitationResponse: async (r) => {
        response = r;
      },
      onSend: async () => {},
    });

    inputBar.update(
      makeElicitationState({
        properties: {
          pick: {
            type: "string",
            enum: ["alpha", "beta"],
            oneOf: [
              { const: "gamma", title: "Gamma" },
              { const: "delta", title: "Delta" },
            ],
          },
        },
        required: ["pick"],
      }),
    );

    // "alpha" is in enum, should be accepted
    await inputBar.submit("alpha");
    expect(response).toEqual({ action: "accept", content: { pick: "alpha" } });
  });

  test("enum takes precedence — oneOf-only values are rejected", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 4 });
    let response: ACPA2AElicitationResponse | undefined;

    const inputBar = createClientInputBar(renderer, {
      onAuthSelection: async () => {},
      onElicitationResponse: async (r) => {
        response = r;
      },
      onSend: async () => {},
    });

    inputBar.update(
      makeElicitationState({
        properties: {
          pick: {
            type: "string",
            enum: ["alpha", "beta"],
            oneOf: [
              { const: "gamma", title: "Gamma" },
              { const: "delta", title: "Delta" },
            ],
          },
        },
        required: ["pick"],
      }),
    );

    // "gamma" is in oneOf but not enum — should be rejected
    await inputBar.submit("gamma");
    expect(response).toBeUndefined();
  });

  test("oneOf without titles shows plain options", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 200,
      height: 4,
    });

    const inputBar = createClientInputBar(renderer, {
      onAuthSelection: async () => {},
      onElicitationResponse: async () => {},
      onSend: async () => {},
    });
    renderer.root.add(inputBar.root);

    inputBar.update(
      makeElicitationState({
        properties: {
          size: {
            type: "string",
            oneOf: [{ const: "small" }, { const: "large" }],
          },
        },
      }),
    );

    await renderOnce();
    const frame = captureCharFrame();
    // No titles, should show plain: "Options: small, large"
    expect(frame).toContain("Options: small, large");
    // Should NOT contain titled annotations like "small (Small)"
    expect(frame).not.toContain("small (");
    expect(frame).not.toContain("large (");
  });

  test("array field with items.oneOf extracts values", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 4 });
    let response: ACPA2AElicitationResponse | undefined;

    const inputBar = createClientInputBar(renderer, {
      onAuthSelection: async () => {},
      onElicitationResponse: async (r) => {
        response = r;
      },
      onSend: async () => {},
    });

    inputBar.update(
      makeElicitationState({
        properties: {
          tags: {
            type: "array",
            items: {
              type: "string",
              oneOf: [
                { const: "bug", title: "Bug Report" },
                { const: "feat", title: "Feature Request" },
              ],
            },
          },
        },
        required: ["tags"],
      }),
    );

    // Valid multi-select from items.oneOf
    await inputBar.submit("bug, feat");
    expect(response).toEqual({
      action: "accept",
      content: { tags: ["bug", "feat"] },
    });
  });

  test("array field rejects values not in items.oneOf", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 4 });
    let response: ACPA2AElicitationResponse | undefined;

    const inputBar = createClientInputBar(renderer, {
      onAuthSelection: async () => {},
      onElicitationResponse: async (r) => {
        response = r;
      },
      onSend: async () => {},
    });

    inputBar.update(
      makeElicitationState({
        properties: {
          tags: {
            type: "array",
            items: {
              type: "string",
              oneOf: [
                { const: "bug", title: "Bug Report" },
                { const: "feat", title: "Feature Request" },
              ],
            },
          },
        },
        required: ["tags"],
      }),
    );

    // "fix" is not in items.oneOf
    await inputBar.submit("bug, fix");
    expect(response).toBeUndefined();
  });

  test("oneOf entries without const are silently skipped", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 4 });
    let response: ACPA2AElicitationResponse | undefined;

    const inputBar = createClientInputBar(renderer, {
      onAuthSelection: async () => {},
      onElicitationResponse: async (r) => {
        response = r;
      },
      onSend: async () => {},
    });

    inputBar.update(
      makeElicitationState({
        properties: {
          pick: {
            type: "string",
            oneOf: [
              { const: "valid" },
              { title: "Missing Const" }, // no const — should be skipped
              42, // non-object — should be skipped
            ],
          },
        },
        required: ["pick"],
      }),
    );

    await inputBar.submit("valid");
    expect(response).toEqual({ action: "accept", content: { pick: "valid" } });
  });
});
