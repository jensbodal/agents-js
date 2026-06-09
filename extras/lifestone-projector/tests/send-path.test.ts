import { describe, expect, test } from "bun:test";
import { annotateDelivered, type OutboxSendFn, routeOutboxContent } from "../src/index.ts";

// Increment (c) maildrop send-path: outbox file content -> gateway send_message
// -> pending(delivered)|failed. Pure except the injected sendMessage spy; no
// gateway, no creds, no fs. This is the PRIMARY shape (Jens [Decision]).

const OUTBOX = "---\nto: cognee-claude\nid: abc-1\n---\n\nhello from the maildrop\n";

function okSend(eventId = "$evt-123"): { fn: OutboxSendFn; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    fn: async (args) => {
      calls.push(args);
      return { ok: true, event_id: eventId };
    },
  };
}

describe("routeOutboxContent — delivered path", () => {
  test("sends to the parsed target as the owner identity, lands in pending/", async () => {
    const send = okSend();
    const out = await routeOutboxContent(OUTBOX, {
      sendMessage: send.fn,
      identity: "hostname-null-claude-0",
    });
    expect(send.calls[0]).toEqual({
      target: "cognee-claude",
      body: "hello from the maildrop",
      identity: "hostname-null-claude-0",
    });
    expect(out.kind).toBe("delivered");
    expect(out.dest).toBe("pending");
    if (out.kind === "delivered") {
      expect(out.target).toBe("cognee-claude");
      expect(out.gatewayId).toBe("$evt-123");
      expect(out.annotatedContent).toContain("state: delivered");
      expect(out.annotatedContent).toContain("gateway_id: $evt-123");
      expect(out.annotatedContent).toContain("hello from the maildrop");
    }
  });
});

describe("routeOutboxContent — failure paths (never silently sent)", () => {
  test("a parse failure (missing `to`) lands in failed/ and NEVER calls sendMessage", async () => {
    const send = okSend();
    const out = await routeOutboxContent("---\nid: x\n---\nbody", {
      sendMessage: send.fn,
      identity: "me",
    });
    expect(send.calls.length).toBe(0);
    expect(out.kind).toBe("parse-failed");
    expect(out.dest).toBe("failed");
  });

  test("gateway ok:false lands in failed/ with the detail", async () => {
    const out = await routeOutboxContent(OUTBOX, {
      identity: "me",
      sendMessage: async () => ({ ok: false, detail: "unknown-target" }),
    });
    expect(out.kind).toBe("send-failed");
    expect(out.dest).toBe("failed");
    if (out.kind === "send-failed") expect(out.error).toBe("unknown-target");
  });

  test("a thrown sendMessage (transport error) lands in failed/, not lost", async () => {
    const out = await routeOutboxContent(OUTBOX, {
      identity: "me",
      sendMessage: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(out.kind).toBe("send-failed");
    expect(out.dest).toBe("failed");
    if (out.kind === "send-failed") expect(out.error).toContain("ECONNREFUSED");
  });
});

describe("annotateDelivered", () => {
  test("adds state:delivered + gateway_id, preserving body", () => {
    const r = annotateDelivered("---\nto: x\n---\n\nbody text\n", "$g1");
    expect(r).toContain("to: x");
    expect(r).toContain("state: delivered");
    expect(r).toContain("gateway_id: $g1");
    expect(r).toContain("body text");
  });
  test("replaces a prior state/gateway_id rather than duplicating", () => {
    const r = annotateDelivered("---\nto: x\nstate: pending\ngateway_id: old\n---\nbody", "$new");
    expect(r.match(/^state: /gm)?.length).toBe(1);
    expect(r).toContain("state: delivered");
    expect(r).toContain("gateway_id: $new");
    expect(r).not.toContain("old");
  });
  test("CRLF-tolerant + frontmatter-less content gets a minimal terminal block", () => {
    const r = annotateDelivered("just a body no frontmatter", "$g");
    expect(r.startsWith("---\nstate: delivered")).toBe(true);
    expect(r).toContain("just a body no frontmatter");
  });
});
