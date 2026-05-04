import { describe, expect, test } from "bun:test";
import pkg from "../package.json";
import { CLI_VERSION, formatVersionLine, handleVersionFlag } from "../src/version.ts";

describe("CLI_VERSION", () => {
  test("matches the version field of packages/cli/package.json", () => {
    expect(CLI_VERSION).toBe(pkg.version);
  });
});

describe("handleVersionFlag", () => {
  function captureWrite(): {
    write: (chunk: string) => boolean;
    output: () => string;
  } {
    const chunks: string[] = [];
    return {
      write: (chunk: string): boolean => {
        chunks.push(chunk);
        return true;
      },
      output: () => chunks.join(""),
    };
  }

  test("returns 0 and writes the source-mode banner for --version", () => {
    const buf = captureWrite();
    const exit = handleVersionFlag(["--version"], { write: buf.write });
    expect(exit).toBe(0);
    expect(buf.output()).toBe(`${formatVersionLine()}\n`);
    // In tests we run from source, so the banner is the (source) form.
    expect(buf.output()).toBe(`agents-js ${CLI_VERSION} (source)\n`);
  });

  test("returns 0 and writes the banner for -v", () => {
    const buf = captureWrite();
    const exit = handleVersionFlag(["-v"], { write: buf.write });
    expect(exit).toBe(0);
    expect(buf.output()).toBe(`${formatVersionLine()}\n`);
  });

  test("returns undefined and writes nothing when no version flag is present", () => {
    const buf = captureWrite();
    const exit = handleVersionFlag(["something-else"], { write: buf.write });
    expect(exit).toBeUndefined();
    expect(buf.output()).toBe("");
  });
});
