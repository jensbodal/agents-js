import { describe, expect, test } from "bun:test";
import { formatInboxRowForCodex } from "../src/prompt-format.ts";

describe("formatInboxRowForCodex", () => {
  test("includes required inbox evidence and routable reply_to", () => {
    const out = formatInboxRowForCodex({
      message_id: "m1",
      kind: "agents_message",
      body: "hello",
      sender: "ajs-claude",
    });

    expect(out.replyTo).toBe("ajs-claude");
    expect(out.prompt).toContain("message_id: m1");
    expect(out.prompt).toContain("kind: agents_message");
    expect(out.prompt).toContain("sender_identity: ajs-claude");
    expect(out.prompt).toContain("reply_to: ajs-claude");
    expect(out.prompt).toContain("Body:\nhello");
  });

  test("includes Matrix origin evidence without fabricating reply_to", () => {
    const out = formatInboxRowForCodex({
      message_id: "m2",
      kind: "matrix_room_mention",
      body: "from room",
      matrix_origin: {
        sender: "@alice:matrix.example",
        room_id: "!room:matrix.example",
        event_id: "$evt",
      },
    });

    expect(out.replyTo).toBeUndefined();
    expect(out.prompt).toContain("sender_identity: @alice:matrix.example");
    expect(out.prompt).toContain("room_id: !room:matrix.example");
    expect(out.prompt).toContain("matrix_event_id: $evt");
    expect(out.prompt).not.toContain("reply_to:");
  });
});
