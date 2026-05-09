import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../src/index.ts";
import { loadJsonFromSource } from "../src/loader.ts";

let tempDir = "";

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "agents-validation-"));
});

afterAll(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("loadJsonFromSource", () => {
  test("returns object source unchanged", async () => {
    const input = { hello: "world" };
    const output = await loadJsonFromSource(input);
    expect(output).toEqual(input);
  });

  test("loads JSON from local file path", async () => {
    const filePath = join(tempDir, "fixture.json");
    await writeFile(filePath, JSON.stringify({ from: "file" }), "utf8");

    const output = await loadJsonFromSource(filePath);
    expect(output).toEqual({ from: "file" });
  });

  test("loads JSON from http URL", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(_req) {
        return new Response(JSON.stringify({ from: "url" }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    try {
      const output = await loadJsonFromSource(`http://127.0.0.1:${server.port}/data.json`);
      expect(output).toEqual({ from: "url" });
    } finally {
      server.stop(true);
    }
  });

  test("throws on 404 URL", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(_req) {
        return new Response("missing", { status: 404 });
      },
    });

    try {
      await expect(
        loadJsonFromSource(`http://127.0.0.1:${server.port}/missing.json`),
      ).rejects.toThrow(ValidationError);
    } finally {
      server.stop(true);
    }
  });

  test("throws on invalid source type", async () => {
    await expect(loadJsonFromSource(123 as unknown as string)).rejects.toThrow(ValidationError);
  });
});
