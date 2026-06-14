/**
 * Slice-2 — A2A file-reference (URI) parts survive into the ACP prompt.
 *
 * `getMessageText()` flattens an A2A message to text and DROPS every
 * non-text part. That silently discards a file reference sent as a
 * `{ content: { $case: "url" } }` part — the ratified files.q4m.dev
 * contract (presigned GET URL in an A2A `url` part; the agent fetches it
 * itself, agents-js never proxies bytes).
 *
 * `getMessageContentBlocks()` keeps the concatenated text block FIRST
 * (byte-identical to the old text-only path → zero regression) and
 * APPENDS one ACP `resource_link` ContentBlock per `url` part. The ACP
 * spec mandates every agent support Text + ResourceLink, so this is the
 * baseline-safe mapping.
 */

import { describe, expect, test } from "bun:test";
import { type Message, type Part, Role } from "@a2a-js/sdk";
import { getMessageContentBlocks } from "../src/index.ts";

function textPart(text: string): Part {
  return {
    content: { $case: "text", value: text },
    metadata: undefined,
    filename: "",
    mediaType: "",
  };
}

function urlPart(uri: string, filename = "", mediaType = ""): Part {
  return { content: { $case: "url", value: uri }, metadata: undefined, filename, mediaType };
}

function message(parts: Part[]): Message {
  return { kind: "message", messageId: "m1", role: Role.ROLE_USER, parts } as unknown as Message;
}

describe("getMessageContentBlocks", () => {
  test("text-only message → a single text block (byte-identical to the old path)", () => {
    const blocks = getMessageContentBlocks(message([textPart("hello "), textPart("world")]));
    expect(blocks).toEqual([{ type: "text", text: "hello world" }]);
  });

  test("url part with filename + mediaType → resource_link carrying uri/name/mimeType", () => {
    const blocks = getMessageContentBlocks(
      message([
        textPart("see attached"),
        urlPart("https://files.q4m.dev/bucket/report.pdf?sig=abc", "report.pdf", "application/pdf"),
      ]),
    );
    expect(blocks).toEqual([
      { type: "text", text: "see attached" },
      {
        type: "resource_link",
        uri: "https://files.q4m.dev/bucket/report.pdf?sig=abc",
        name: "report.pdf",
        mimeType: "application/pdf",
      },
    ]);
  });

  test("url-only message (no caption) → resource_link only, no empty leading text block", () => {
    const blocks = getMessageContentBlocks(
      message([urlPart("https://files.q4m.dev/bucket/photo.jpg?X-Amz-Signature=xyz")]),
    );
    // The folder-inbox/upload case: dropping the empty text block keeps the
    // prompt clean for adapters that mishandle a leading "" text block.
    expect(blocks).toEqual([
      {
        type: "resource_link",
        uri: "https://files.q4m.dev/bucket/photo.jpg?X-Amz-Signature=xyz",
        name: "photo.jpg",
      },
    ]);
  });

  test("url part with no usable path segment → name falls back to 'attachment'", () => {
    const blocks = getMessageContentBlocks(message([urlPart("https://files.q4m.dev/")]));
    expect(blocks).toEqual([
      { type: "resource_link", uri: "https://files.q4m.dev/", name: "attachment" },
    ]);
  });

  test("fully empty message → a single empty text block (never an empty prompt array)", () => {
    expect(getMessageContentBlocks(message([]))).toEqual([{ type: "text", text: "" }]);
  });

  test("raw / data parts are dropped (not forwarded) and reported via logger.debug", () => {
    const debugged: string[] = [];
    const logger = {
      info() {},
      warn() {},
      error() {},
      debug(msg: string) {
        debugged.push(msg);
      },
    };
    const blocks = getMessageContentBlocks(
      message([
        textPart("caption"),
        {
          content: { $case: "raw", value: Buffer.from("x") },
          metadata: undefined,
          filename: "",
          mediaType: "",
        } as Part,
        {
          content: { $case: "data", value: { k: 1 } },
          metadata: undefined,
          filename: "",
          mediaType: "",
        } as Part,
      ]),
      logger,
    );
    expect(blocks).toEqual([{ type: "text", text: "caption" }]);
    expect(debugged).toHaveLength(2);
    expect(debugged[0]).toContain("$case=raw");
    expect(debugged[1]).toContain("$case=data");
  });

  test("multiple url parts → one resource_link each, in order, after the text block", () => {
    const blocks = getMessageContentBlocks(
      message([
        textPart("two files"),
        urlPart("https://files.q4m.dev/a.txt", "a.txt"),
        urlPart("https://files.q4m.dev/b.txt", "b.txt"),
      ]),
    );
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toEqual({
      type: "resource_link",
      uri: "https://files.q4m.dev/a.txt",
      name: "a.txt",
    });
    expect(blocks[2]).toEqual({
      type: "resource_link",
      uri: "https://files.q4m.dev/b.txt",
      name: "b.txt",
    });
  });
});
