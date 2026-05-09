import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createTerminalPromptSession } from "../src/prompts.ts";

function createStreams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let outputText = "";
  output.on("data", (chunk: Buffer) => {
    outputText += chunk.toString();
  });
  return {
    input,
    output,
    getOutput: () => outputText,
  };
}

describe("prompts", () => {
  describe("input", () => {
    test("returns user input trimmed", async () => {
      const { input, output } = createStreams();
      const session = createTerminalPromptSession(input, output);

      const promise = session.input("Enter name");
      input.write("  Alice  \n");
      const result = await promise;

      expect(result).toBe("Alice");
      session.close();
    });

    test("returns default value when empty input is given", async () => {
      const { input, output } = createStreams();
      const session = createTerminalPromptSession(input, output);

      const promise = session.input("Enter name", "DefaultName");
      input.write("\n");
      const result = await promise;

      expect(result).toBe("DefaultName");
      session.close();
    });

    test("returns empty string when no default and empty input", async () => {
      const { input, output } = createStreams();
      const session = createTerminalPromptSession(input, output);

      const promise = session.input("Enter name");
      input.write("\n");
      const result = await promise;

      expect(result).toBe("");
      session.close();
    });

    test("shows default value in prompt suffix", async () => {
      const { input, output, getOutput } = createStreams();
      const session = createTerminalPromptSession(input, output);

      const promise = session.input("Project", "my-project");
      input.write("\n");
      await promise;

      expect(getOutput()).toContain("[my-project]");
      session.close();
    });
  });

  describe("confirm", () => {
    test("returns true for 'y' input", async () => {
      const { input, output } = createStreams();
      const session = createTerminalPromptSession(input, output);

      const promise = session.confirm("Continue?");
      input.write("y\n");
      const result = await promise;

      expect(result).toBe(true);
      session.close();
    });

    test("returns true for 'yes' input", async () => {
      const { input, output } = createStreams();
      const session = createTerminalPromptSession(input, output);

      const promise = session.confirm("Continue?");
      input.write("yes\n");
      const result = await promise;

      expect(result).toBe(true);
      session.close();
    });

    test("returns false for 'n' input", async () => {
      const { input, output } = createStreams();
      const session = createTerminalPromptSession(input, output);

      const promise = session.confirm("Continue?");
      input.write("n\n");
      const result = await promise;

      expect(result).toBe(false);
      session.close();
    });

    test("returns false for 'no' input", async () => {
      const { input, output } = createStreams();
      const session = createTerminalPromptSession(input, output);

      const promise = session.confirm("Continue?");
      input.write("no\n");
      const result = await promise;

      expect(result).toBe(false);
      session.close();
    });

    test("returns true default when empty input and default is true", async () => {
      const { input, output } = createStreams();
      const session = createTerminalPromptSession(input, output);

      const promise = session.confirm("Continue?", true);
      input.write("\n");
      const result = await promise;

      expect(result).toBe(true);
      session.close();
    });

    test("returns false default when empty input and default is false", async () => {
      const { input, output } = createStreams();
      const session = createTerminalPromptSession(input, output);

      const promise = session.confirm("Continue?", false);
      input.write("\n");
      const result = await promise;

      expect(result).toBe(false);
      session.close();
    });

    test("shows [Y/n] prompt when default is true", async () => {
      const { input, output, getOutput } = createStreams();
      const session = createTerminalPromptSession(input, output);

      const promise = session.confirm("Continue?", true);
      input.write("y\n");
      await promise;

      expect(getOutput()).toContain("[Y/n]");
      session.close();
    });

    test("shows [y/N] prompt when default is false", async () => {
      const { input, output, getOutput } = createStreams();
      const session = createTerminalPromptSession(input, output);

      const promise = session.confirm("Continue?", false);
      input.write("n\n");
      await promise;

      expect(getOutput()).toContain("[y/N]");
      session.close();
    });

    test("re-prompts on invalid input then accepts valid", async () => {
      const { input, output, getOutput } = createStreams();
      const session = createTerminalPromptSession(input, output);

      const promise = session.confirm("Continue?");
      input.write("maybe\n");
      // Give time for the re-prompt
      await new Promise((r) => setTimeout(r, 50));
      input.write("y\n");
      const result = await promise;

      expect(result).toBe(true);
      expect(getOutput()).toContain("Enter y or n.");
      session.close();
    });
  });

  describe("select", () => {
    test("returns the selected option value by number", async () => {
      const { input, output } = createStreams();
      const session = createTerminalPromptSession(input, output);

      const promise = session.select("Choose:", [
        { value: "a", label: "Option A" },
        { value: "b", label: "Option B" },
        { value: "c", label: "Option C" },
      ]);
      input.write("2\n");
      const result = await promise;

      expect(result).toBe("b");
      session.close();
    });

    test("displays all options with numbers", async () => {
      const { input, output, getOutput } = createStreams();
      const session = createTerminalPromptSession(input, output);

      const promise = session.select("Choose:", [
        { value: "a", label: "First" },
        { value: "b", label: "Second" },
      ]);
      input.write("1\n");
      await promise;

      const out = getOutput();
      expect(out).toContain("1. First");
      expect(out).toContain("2. Second");
      session.close();
    });

    test("displays hints when provided", async () => {
      const { input, output, getOutput } = createStreams();
      const session = createTerminalPromptSession(input, output);

      const promise = session.select("Choose:", [
        { value: "dev", label: "Development", hint: "local env" },
        { value: "prod", label: "Production", hint: "live env" },
      ]);
      input.write("1\n");
      await promise;

      const out = getOutput();
      expect(out).toContain("Development");
      expect(out).toContain("local env");
      expect(out).toContain("Production");
      expect(out).toContain("live env");
      session.close();
    });

    test("re-prompts on out-of-range input", async () => {
      const { input, output, getOutput } = createStreams();
      const session = createTerminalPromptSession(input, output);

      const promise = session.select("Choose:", [
        { value: "a", label: "Option A" },
        { value: "b", label: "Option B" },
      ]);
      input.write("5\n");
      await new Promise((r) => setTimeout(r, 50));
      input.write("1\n");
      const result = await promise;

      expect(result).toBe("a");
      expect(getOutput()).toContain("Enter one of the listed numbers.");
      session.close();
    });

    test("re-prompts on non-numeric input", async () => {
      const { input, output, getOutput } = createStreams();
      const session = createTerminalPromptSession(input, output);

      const promise = session.select("Choose:", [{ value: "x", label: "Only" }]);
      input.write("abc\n");
      await new Promise((r) => setTimeout(r, 50));
      input.write("1\n");
      const result = await promise;

      expect(result).toBe("x");
      expect(getOutput()).toContain("Enter one of the listed numbers.");
      session.close();
    });
  });

  describe("close", () => {
    test("close() does not throw", () => {
      const { input, output } = createStreams();
      const session = createTerminalPromptSession(input, output);
      expect(() => session.close()).not.toThrow();
    });
  });
});
