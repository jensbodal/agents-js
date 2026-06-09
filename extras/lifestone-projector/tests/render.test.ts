import { describe, expect, test } from "bun:test";
import {
  dedupKey,
  type ProjectedInboxMessage,
  parseOutboxFile,
  renderInboxMessageToFile,
  resolveFrom,
  resolveTimestampMs,
  sanitizeForFilename,
  sanitizeHeaderValue,
  slugify,
  toCompactStamp,
} from "../src/index.ts";

// `@agents-js/lifestone-projector` increment (a): the pure render/parse
// core. Every assertion is on a deterministic function of its inputs — no
// clock, no I/O, no credentials — so the daemon legs can build on it safely.

const BRIDGE_ROW: ProjectedInboxMessage = {
  message_id: "019eaa42-875e-7a6f-97b0-9415035d6bf1",
  body: "hey @hostname-null-ajs-pi-0 please ack",
  kind: "matrix_room_mention",
  idempotency_key: "$evt123:hostname-null-ajs-pi-0",
  matrix_origin: {
    event_id: "$evt123",
    room_id: "!room:server",
    sender: "@jensbodal:matrix.tail019e7.ts.net",
    origin_server_ts: 1780900000000,
    reply_to_event_id: "$prev999",
  },
};

const NATIVE_ROW: ProjectedInboxMessage = {
  message_id: "native-row-1",
  body: "Direct agent note",
  sender: "cognee-claude",
  created_at: "2026-06-08T21:00:00.000Z",
  idempotency_key: null,
};

describe("dedupKey", () => {
  test("bridge rows dedup on idempotency_key", () => {
    expect(dedupKey(BRIDGE_ROW)).toBe("$evt123:hostname-null-ajs-pi-0");
  });
  test("native rows (null idempotency_key) fall back to message_id", () => {
    expect(dedupKey(NATIVE_ROW)).toBe("native-row-1");
  });
  test("empty-string idempotency_key also falls back to message_id", () => {
    expect(dedupKey({ message_id: "m1", body: "x", idempotency_key: "" })).toBe("m1");
  });
});

describe("slugify", () => {
  test("kebab-cases, strips punctuation, caps word count", () => {
    expect(slugify("Hey @pi, please ACK the thing now!!", 4)).toBe("hey-pi-please-ack");
  });
  test("empty/punctuation-only text falls back to 'message'", () => {
    expect(slugify("!!!")).toBe("message");
  });
});

describe("sanitizeForFilename", () => {
  test("strips MXID @ and : punctuation", () => {
    expect(sanitizeForFilename("@jensbodal:matrix.tail019e7.ts.net")).toBe(
      "jensbodal-matrix.tail019e7.ts.net",
    );
  });
});

describe("resolveTimestampMs / resolveFrom", () => {
  test("prefers matrix origin_server_ts", () => {
    expect(resolveTimestampMs(BRIDGE_ROW)).toBe(1780900000000);
  });
  test("parses ISO created_at when no matrix origin", () => {
    expect(resolveTimestampMs(NATIVE_ROW)).toBe(Date.parse("2026-06-08T21:00:00.000Z"));
  });
  test("undefined when no timestamp present", () => {
    expect(resolveTimestampMs({ message_id: "m", body: "b" })).toBeUndefined();
  });
  test("from prefers matrix sender, else native sender, else unknown", () => {
    expect(resolveFrom(BRIDGE_ROW)).toBe("@jensbodal:matrix.tail019e7.ts.net");
    expect(resolveFrom(NATIVE_ROW)).toBe("cognee-claude");
    expect(resolveFrom({ message_id: "m", body: "b" })).toBe("unknown");
  });
});

describe("toCompactStamp", () => {
  test("compact sortable UTC stamp, deterministic", () => {
    expect(toCompactStamp(1780900000000)).toBe(
      new Date(1780900000000)
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z$/, "Z"),
    );
    expect(toCompactStamp(1780900000000)).toMatch(/^\d{8}T\d{6}Z$/);
  });
});

describe("renderInboxMessageToFile", () => {
  const rendered = renderInboxMessageToFile(BRIDGE_ROW, "hostname-null-ajs-pi-0");

  test("filename is <stamp>__<from>__<slug>.md, all filename-safe", () => {
    expect(rendered.filename).toMatch(/^\d{8}T\d{6}Z__jensbodal-matrix[^_]+__[a-z0-9-]+\.md$/);
    expect(rendered.filename).toContain("__hey-hostname-null-ajs-pi-0.md");
    expect(rendered.filename).not.toContain("@");
    expect(rendered.filename).not.toContain(":");
  });
  test("frontmatter carries gateway_id, from, to, kind, state=rendered", () => {
    expect(rendered.content).toContain("gateway_id: 019eaa42-875e-7a6f-97b0-9415035d6bf1");
    expect(rendered.content).toContain("from: @jensbodal:matrix.tail019e7.ts.net");
    expect(rendered.content).toContain("to: hostname-null-ajs-pi-0");
    expect(rendered.content).toContain("kind: matrix_room_mention");
    expect(rendered.content).toContain("state: rendered");
    expect(rendered.content).toContain("in_reply_to: $prev999");
  });
  test("body is preserved after the frontmatter block", () => {
    expect(rendered.content.endsWith("hey @hostname-null-ajs-pi-0 please ack\n")).toBe(true);
  });
  test("dedupKey is carried for the daemon's seen-set", () => {
    expect(rendered.dedupKey).toBe("$evt123:hostname-null-ajs-pi-0");
  });
  test("is deterministic — same input renders byte-identical output", () => {
    const again = renderInboxMessageToFile(BRIDGE_ROW, "hostname-null-ajs-pi-0");
    expect(again).toEqual(rendered);
  });
  test("handles a row with no timestamp via sentinel stamp", () => {
    const r = renderInboxMessageToFile({ message_id: "m", body: "no ts", sender: "x" }, "owner");
    expect(r.filename.startsWith("00000000T000000Z__")).toBe(true);
    expect(r.content).toContain("ts: \n");
  });
});

// cognee-claude #161 follow-up note 1: a row field carrying a newline must not
// inject extra YAML lines or close the --- block early.
describe("sanitizeHeaderValue + frontmatter-injection safety", () => {
  test("collapses newlines/CR/tabs to a space, keeps hyphens", () => {
    expect(sanitizeHeaderValue("a\nb\r\nc\td")).toBe("a b c d");
    expect(sanitizeHeaderValue("hostname-null-ajs-pi-0")).toBe("hostname-null-ajs-pi-0");
  });
  test("a hostile `from` with an embedded newline cannot add a YAML line", () => {
    const hostile = renderInboxMessageToFile(
      { message_id: "m", body: "b", sender: "evil\nstate: spoofed" },
      "owner",
    );
    // The injected `state: spoofed` is flattened into the from line, not a new key.
    expect(hostile.content).toContain("from: evil state: spoofed");
    // Exactly one real `state:` line (the rendered one), no injected duplicate.
    expect(hostile.content.match(/^state: rendered$/gm)?.length).toBe(1);
    expect(hostile.content.match(/^state: spoofed$/gm)).toBeNull();
  });
  test("frontmatter still has exactly two --- fences (block not broken)", () => {
    const r = renderInboxMessageToFile(
      { message_id: "m", body: "b", sender: "x\n---\ninjected" },
      "owner",
    );
    expect(r.content.match(/^---$/gm)?.length).toBe(2);
  });
});

// cognee-claude #161 follow-up note 2: CRLF-composed outbox files must parse.
describe("parseOutboxFile CRLF tolerance", () => {
  test("parses a \\r\\n (Windows/phone) outbox file identically to \\n", () => {
    const crlf = "---\r\nto: cognee-claude\r\nid: abc-1\r\n---\r\n\r\nhello there\r\n";
    expect(parseOutboxFile(crlf)).toEqual({
      ok: true,
      to: "cognee-claude",
      body: "hello there",
      id: "abc-1",
    });
  });
});

describe("parseOutboxFile", () => {
  test("parses to + body + optional id", () => {
    const r = parseOutboxFile("---\nto: cognee-claude\nid: abc-1\n---\n\nhello there\n");
    expect(r).toEqual({ ok: true, to: "cognee-claude", body: "hello there", id: "abc-1" });
  });
  test("to is required — missing to is a typed failure, not a guess", () => {
    const r = parseOutboxFile("---\nid: x\n---\nbody");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("`to`");
  });
  test("empty body is a typed failure", () => {
    const r = parseOutboxFile("---\nto: x\n---\n\n   \n");
    expect(r.ok).toBe(false);
  });
  test("no frontmatter block is a typed failure", () => {
    const r = parseOutboxFile("just some text");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("frontmatter");
  });
  test("render → parse round-trips the body for a composed reply", () => {
    const out = "---\nto: hostname-null-claude-0\n---\n\nround trip body\n";
    const parsed = parseOutboxFile(out);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.body).toBe("round trip body");
  });
});
