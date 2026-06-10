import { describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { runMcpSendServer } from "../src/mcp-send-server.ts";

function frame(message: unknown): string {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

describe("runMcpSendServer", () => {
  test("advertises only the send_message tool for the Claude reply leg", async () => {
    const stdin = new PassThrough();
    let output = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });

    const run = runMcpSendServer({
      identity: "hostname-null-claude-0",
      gatewayUrl: "https://gw.test",
      keyCommand: "unused",
      stdin,
      stdout,
      client: {
        async getMessages() {
          throw new Error("send-only MCP server must not read inbox messages");
        },
        async sendMessage() {
          return { ok: true };
        },
        async close() {},
      },
    });

    stdin.write(frame({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    stdin.end();
    await run;

    expect(output).toContain('"name":"agents_send_message"');
    expect(output).not.toContain("agents_get_messages");
  });
});
