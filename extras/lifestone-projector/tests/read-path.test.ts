import { describe, expect, test } from "bun:test";
import {
  buildInboxFilePath,
  createInboxRenderSink,
  type ProjectedInboxMessage,
  safePathSegment,
} from "../src/index.ts";

// Increment (b) read-path sink: composes the render core with an injected
// writer. No gateway, no creds, no adapter dependency — the poller (which owns
// the loop/dedup/identity-guard) calls this sink per new row.

const ROW: ProjectedInboxMessage = {
  message_id: "019eaa42-875e-7a6f-97b0-9415035d6bf1",
  body: "ping from the room",
  kind: "matrix_room_mention",
  idempotency_key: "$evt:owner",
  matrix_origin: { sender: "@jensbodal:matrix.tail019e7.ts.net", origin_server_ts: 1780900000000 },
};

describe("safePathSegment", () => {
  test("reduces an owner to one segment, no traversal", () => {
    expect(safePathSegment("../../etc/passwd")).toBe("etc-passwd");
    expect(safePathSegment("a/b\\c")).toBe("a-b-c");
    expect(safePathSegment("hostname-null-ajs-pi-0")).toBe("hostname-null-ajs-pi-0");
  });
  test("degenerate input falls back to 'unknown'", () => {
    expect(safePathSegment("../")).toBe("unknown");
    expect(safePathSegment("")).toBe("unknown");
  });
});

describe("buildInboxFilePath", () => {
  test("joins <root>/<owner>/inbox/<filename>, trims trailing root slash", () => {
    expect(buildInboxFilePath("/vault/hub/agent-inbox/", "owner-1", "f.md")).toBe(
      "/vault/hub/agent-inbox/owner-1/inbox/f.md",
    );
  });
  test("a traversal owner cannot escape the mailbox root", () => {
    const p = buildInboxFilePath("/vault/hub/agent-inbox", "../../escape", "f.md");
    expect(p).toBe("/vault/hub/agent-inbox/escape/inbox/f.md");
    expect(p).not.toContain("..");
  });
});

describe("createInboxRenderSink", () => {
  test("renders the row and writes it to the owner's inbox path", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const sink = createInboxRenderSink({
      owner: "hostname-null-ajs-pi-0",
      mailboxRoot: "/vault/hub/agent-inbox",
      writeFile: (path, content) => {
        writes.push({ path, content });
      },
    });

    const rendered = await sink(ROW);

    expect(writes.length).toBe(1);
    expect(writes[0]?.path).toBe(
      `/vault/hub/agent-inbox/hostname-null-ajs-pi-0/inbox/${rendered.filename}`,
    );
    expect(writes[0]?.content).toBe(rendered.content);
    expect(rendered.content).toContain("to: hostname-null-ajs-pi-0");
    expect(rendered.content).toContain("from: @jensbodal:matrix.tail019e7.ts.net");
  });

  test("awaits an async writer (real fs returns a promise)", async () => {
    let written = false;
    const sink = createInboxRenderSink({
      owner: "o",
      mailboxRoot: "/r",
      writeFile: async (_p, _c) => {
        await Promise.resolve();
        written = true;
      },
    });
    await sink(ROW);
    expect(written).toBe(true);
  });

  test("idempotent at file level: same row -> same path + byte-identical content", async () => {
    const calls: Array<{ path: string; content: string }> = [];
    const sink = createInboxRenderSink({
      owner: "o",
      mailboxRoot: "/r",
      writeFile: (path, content) => {
        calls.push({ path, content });
      },
    });
    await sink(ROW);
    await sink(ROW);
    expect(calls[0]).toEqual(calls[1] as { path: string; content: string });
  });

  test("writes only into the owner's own mailbox (never another agent's)", async () => {
    const paths: string[] = [];
    const sink = createInboxRenderSink({
      owner: "me",
      mailboxRoot: "/r",
      writeFile: (path) => {
        paths.push(path);
      },
    });
    // even though the row was authored by someone else, it lands in MY inbox
    await sink(ROW);
    expect(paths[0]?.startsWith("/r/me/inbox/")).toBe(true);
  });
});
