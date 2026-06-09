import { describe, expect, test } from "bun:test";
import { runKeyCommand } from "../src/key-command.ts";

describe("runKeyCommand", () => {
  test("preserves multiline PEM stdout", async () => {
    const pem = await runKeyCommand(
      "printf '%s\\n%s\\n%s\\n' '-----BEGIN PRIVATE KEY-----' 'abc' '-----END PRIVATE KEY-----'",
    );

    expect(pem).toBe("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
  });
});
