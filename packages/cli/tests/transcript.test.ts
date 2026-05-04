import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "@agents-js/a2a-client";
import { createInitialSessionState } from "@agents-js/a2a-client";
import { createTestRenderer } from "@opentui/core/testing";
import { createClientTranscriptView } from "../src/client/ui/transcript.ts";

function makeEntry(
  overrides: Partial<TranscriptEntry> & Pick<TranscriptEntry, "role" | "text">,
): TranscriptEntry {
  return {
    id: crypto.randomUUID(),
    ...overrides,
  };
}

/** Helper: extract plain text from a transcript entry's nested TextRenderable */
function getChildText(
  root: ReturnType<typeof createClientTranscriptView>["root"],
  childId: string,
): string | undefined {
  const child = root.getChildren().find((c) => c.id === childId);
  if (!child) return undefined;
  const textNode = child.getChildren()[0];
  if (!textNode || !("content" in textNode)) return undefined;
  const content = (textNode as { content: { chunks?: Array<{ text: string }> } }).content;
  if (content && typeof content === "object" && Array.isArray(content.chunks)) {
    return content.chunks.map((c) => c.text).join("");
  }
  return String(content);
}

describe("transcript", () => {
  test("shows placeholder when transcript is empty and no pending text", async () => {
    const { renderer } = await createTestRenderer({ width: 60, height: 6 });
    const transcript = createClientTranscriptView(renderer);
    renderer.root.add(transcript.root);

    transcript.update(createInitialSessionState());

    const children = transcript.root.getChildren();
    expect(children.length).toBe(1);
    expect(children[0]?.id).toBe("client-transcript-placeholder");
  });

  test("removes placeholder when transcript has entries", async () => {
    const { renderer } = await createTestRenderer({ width: 60, height: 6 });
    const transcript = createClientTranscriptView(renderer);
    renderer.root.add(transcript.root);

    transcript.update(
      createInitialSessionState({
        transcript: [makeEntry({ role: "user", text: "hello" })],
      }),
    );

    const childIds = transcript.root.getChildren().map((c) => c.id);
    expect(childIds).not.toContain("client-transcript-placeholder");
    expect(childIds).toContain("client-transcript-entry-0");
  });

  test("renders user messages with role prefix in child text", async () => {
    const { renderer } = await createTestRenderer({ width: 60, height: 6 });
    const transcript = createClientTranscriptView(renderer);
    renderer.root.add(transcript.root);

    transcript.update(
      createInitialSessionState({
        transcript: [makeEntry({ role: "user", text: "What is 2+2?" })],
      }),
    );

    const text = getChildText(transcript.root, "client-transcript-entry-0");
    expect(text).toContain("user:");
    expect(text).toContain("What is 2+2?");
  });

  test("renders agent messages with role prefix in child text", async () => {
    const { renderer } = await createTestRenderer({ width: 60, height: 6 });
    const transcript = createClientTranscriptView(renderer);
    renderer.root.add(transcript.root);

    transcript.update(
      createInitialSessionState({
        transcript: [makeEntry({ role: "agent", text: "The answer is 4." })],
      }),
    );

    const text = getChildText(transcript.root, "client-transcript-entry-0");
    expect(text).toContain("agent:");
    expect(text).toContain("The answer is 4.");
  });

  test("renders multi-turn conversation in order", async () => {
    const { renderer } = await createTestRenderer({ width: 60, height: 10 });
    const transcript = createClientTranscriptView(renderer);
    renderer.root.add(transcript.root);

    transcript.update(
      createInitialSessionState({
        transcript: [
          makeEntry({ role: "user", text: "first" }),
          makeEntry({ role: "agent", text: "second" }),
          makeEntry({ role: "user", text: "third" }),
        ],
      }),
    );

    const children = transcript.root.getChildren();
    expect(children.length).toBe(3);

    expect(children[0]?.id).toBe("client-transcript-entry-0");
    expect(children[1]?.id).toBe("client-transcript-entry-1");
    expect(children[2]?.id).toBe("client-transcript-entry-2");

    expect(getChildText(transcript.root, "client-transcript-entry-0")).toContain("user: first");
    expect(getChildText(transcript.root, "client-transcript-entry-1")).toContain("agent: second");
    expect(getChildText(transcript.root, "client-transcript-entry-2")).toContain("user: third");
  });

  test("shows pending agent text as an additional entry", async () => {
    const { renderer } = await createTestRenderer({ width: 60, height: 8 });
    const transcript = createClientTranscriptView(renderer);
    renderer.root.add(transcript.root);

    transcript.update(
      createInitialSessionState({
        transcript: [makeEntry({ role: "user", text: "hello" })],
        pendingAgentText: "typing something...",
      }),
    );

    const children = transcript.root.getChildren();
    expect(children.length).toBe(2);

    const userText = getChildText(transcript.root, "client-transcript-entry-0");
    expect(userText).toContain("user: hello");

    const pendingText = getChildText(transcript.root, "client-transcript-entry-1");
    expect(pendingText).toContain("agent: typing something...");
  });

  test("pending agent text entry uses transcript length as its index", async () => {
    const { renderer } = await createTestRenderer({ width: 60, height: 8 });
    const transcript = createClientTranscriptView(renderer);
    renderer.root.add(transcript.root);

    transcript.update(
      createInitialSessionState({
        transcript: [
          makeEntry({ role: "user", text: "msg1" }),
          makeEntry({ role: "agent", text: "msg2" }),
        ],
        pendingAgentText: "still typing...",
      }),
    );

    const children = transcript.root.getChildren();
    // 2 transcript entries + 1 pending = 3
    expect(children.length).toBe(3);
    expect(children[2]?.id).toBe("client-transcript-entry-2");
  });

  test("restores placeholder when updated back to empty state", async () => {
    const { renderer } = await createTestRenderer({ width: 60, height: 6 });
    const transcript = createClientTranscriptView(renderer);
    renderer.root.add(transcript.root);

    // First update with content
    transcript.update(
      createInitialSessionState({
        transcript: [makeEntry({ role: "user", text: "hello" })],
      }),
    );
    let childIds = transcript.root.getChildren().map((c) => c.id);
    expect(childIds).toContain("client-transcript-entry-0");
    expect(childIds).not.toContain("client-transcript-placeholder");

    // Then update back to empty
    transcript.update(createInitialSessionState());
    childIds = transcript.root.getChildren().map((c) => c.id);
    expect(childIds).toContain("client-transcript-placeholder");
    expect(childIds).not.toContain("client-transcript-entry-0");
  });

  test("clears previous children on each update", async () => {
    const { renderer } = await createTestRenderer({ width: 60, height: 10 });
    const transcript = createClientTranscriptView(renderer);
    renderer.root.add(transcript.root);

    // Update with 2 messages
    transcript.update(
      createInitialSessionState({
        transcript: [
          makeEntry({ role: "user", text: "one" }),
          makeEntry({ role: "agent", text: "two" }),
        ],
      }),
    );
    expect(transcript.root.getChildren().length).toBe(2);

    // Update with 1 message - should not accumulate
    transcript.update(
      createInitialSessionState({
        transcript: [makeEntry({ role: "user", text: "only" })],
      }),
    );
    expect(transcript.root.getChildren().length).toBe(1);
  });

  test("pending agent text without transcript entries still removes placeholder", async () => {
    const { renderer } = await createTestRenderer({ width: 60, height: 6 });
    const transcript = createClientTranscriptView(renderer);
    renderer.root.add(transcript.root);

    transcript.update(
      createInitialSessionState({
        pendingAgentText: "Agent is thinking...",
      }),
    );

    const childIds = transcript.root.getChildren().map((c) => c.id);
    expect(childIds).not.toContain("client-transcript-placeholder");
    expect(childIds).toContain("client-transcript-entry-0");

    const text = getChildText(transcript.root, "client-transcript-entry-0");
    expect(text).toContain("agent: Agent is thinking...");
  });
});
