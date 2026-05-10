import { describe, expect, test } from "bun:test";
import { AcpTerminalEmbed } from "../src/acp-terminal-embed.ts";

describe("AcpTerminalEmbed", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpTerminalEmbed).toBe("function");
  });

  test("has reactive properties for command / exitCode / output", () => {
    expect(AcpTerminalEmbed.elementProperties.get("command")).toBeDefined();
    expect(AcpTerminalEmbed.elementProperties.get("exitCode")).toBeDefined();
    expect(AcpTerminalEmbed.elementProperties.get("output")).toBeDefined();
  });

  test("default values cover absent-input case", () => {
    const el = new AcpTerminalEmbed();
    expect(el.command).toBe("");
    expect(el.output).toBe("");
    expect(el.exitCode).toBeUndefined();
  });
});
