/**
 * Tests for the default Pi extension resolver.
 *
 * These pin the source/worktree developer path without hard-coding it into CLI
 * config generation: installed package metadata wins, local extras metadata is
 * a development fallback, and an unbuilt extension cleanly falls back to the
 * public `@agents-js/pi-extension` spec at launch-plan time.
 */
import { describe, expect, test } from "bun:test";
import { resolveDefaultPiExtensionSpec } from "../../src/pi-extension-resolution.ts";

function fixtureResolver(files: Record<string, string>) {
  return {
    fileExists: (filePath: string) => Object.hasOwn(files, filePath),
    readTextFile: (filePath: string) => {
      const text = files[filePath];
      if (text === undefined) throw new Error(`missing fixture file: ${filePath}`);
      return text;
    },
  };
}

describe("resolveDefaultPiExtensionSpec", () => {
  test("uses installed @agents-js/pi-extension package metadata when resolvable", () => {
    const files = fixtureResolver({
      "/repo/node_modules/@agents-js/pi-extension/package.json": JSON.stringify({
        pi: { extensions: ["./dist/extension.js"] },
      }),
      "/repo/node_modules/@agents-js/pi-extension/dist/extension.js": "",
    });

    const resolved = resolveDefaultPiExtensionSpec({
      ...files,
      resolveSpecifier: () => "file:///repo/node_modules/@agents-js/pi-extension/package.json",
      moduleUrl: "file:///repo/packages/agent-launch/src/plan.ts",
    });

    expect(resolved).toBe("/repo/node_modules/@agents-js/pi-extension/dist/extension.js");
  });

  test("falls back to source-worktree extras package metadata", () => {
    const files = fixtureResolver({
      "/repo/extras/pi-extension/package.json": JSON.stringify({
        pi: { extensions: ["./dist/extension.js"] },
      }),
      "/repo/extras/pi-extension/dist/extension.js": "",
    });

    const resolved = resolveDefaultPiExtensionSpec({
      ...files,
      resolveSpecifier: () => {
        throw new Error("not installed");
      },
      moduleUrl: "file:///repo/packages/agent-launch/src/plan.ts",
    });

    expect(resolved).toBe("/repo/extras/pi-extension/dist/extension.js");
  });

  test("returns undefined when neither package metadata path has a built extension", () => {
    const files = fixtureResolver({
      "/repo/extras/pi-extension/package.json": JSON.stringify({
        pi: { extensions: ["./dist/extension.js"] },
      }),
    });

    const resolved = resolveDefaultPiExtensionSpec({
      ...files,
      resolveSpecifier: () => {
        throw new Error("not installed");
      },
      moduleUrl: "file:///repo/packages/agent-launch/src/plan.ts",
    });

    expect(resolved).toBeUndefined();
  });
});
