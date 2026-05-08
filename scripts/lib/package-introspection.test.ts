import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCLISubcommandFlags,
  getMethodKeyedRegistryEntries,
  getRuntimeRegistryMatrix,
} from "./package-introspection.ts";

function makeTempPackage(files: Record<string, string>): {
  srcDir: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "pkg-intro-"));
  const srcDir = join(root, "src");
  mkdirSync(srcDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const filePath = join(srcDir, name);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, body);
  }
  return {
    srcDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("getCLISubcommandFlags", () => {
  test("happy path: resolves an inline ArgSpec literal", () => {
    const { srcDir, cleanup } = makeTempPackage({
      "demo.ts": `
        export const DEMO_ARG_SPEC = {
          "--help": { kind: "flag", description: "Show help." },
          "--port": { kind: "value", description: "Bind port.", valueExample: "<port>" },
        };
      `,
    });
    try {
      const flags = getCLISubcommandFlags(srcDir, "demo", "DEMO_ARG_SPEC");
      expect(flags).toEqual([
        { flag: "--help", kind: "flag", description: "Show help." },
        {
          flag: "--port",
          kind: "value",
          description: "Bind port.",
          valueExample: "<port>",
        },
      ]);
    } finally {
      cleanup();
    }
  });

  test("throws when the variable is not declared", () => {
    const { srcDir, cleanup } = makeTempPackage({
      "demo.ts": `export const SOMETHING_ELSE = {};`,
    });
    try {
      expect(() => getCLISubcommandFlags(srcDir, "demo", "MISSING_SPEC")).toThrow(
        /variable "MISSING_SPEC" not found/,
      );
    } finally {
      cleanup();
    }
  });

  test("throws when an entry is missing the kind property", () => {
    const { srcDir, cleanup } = makeTempPackage({
      "demo.ts": `export const DEMO_ARG_SPEC = {
        "--bare": { description: "No kind here." },
      };`,
    });
    try {
      expect(() => getCLISubcommandFlags(srcDir, "demo", "DEMO_ARG_SPEC")).toThrow(
        /has no kind property/,
      );
    } finally {
      cleanup();
    }
  });

  test("throws when an entry's kind is not a string literal", () => {
    const { srcDir, cleanup } = makeTempPackage({
      "demo.ts": `const k = "flag" as const;
        export const DEMO_ARG_SPEC = {
          "--bare": { kind: k, description: "Indirect kind." },
        };`,
    });
    try {
      expect(() => getCLISubcommandFlags(srcDir, "demo", "DEMO_ARG_SPEC")).toThrow(
        /kind is .*, expected string literal/,
      );
    } finally {
      cleanup();
    }
  });
});

describe("getRuntimeRegistryMatrix", () => {
  test("happy path: reads displayName, description, command, install.installHint", () => {
    const { srcDir, cleanup } = makeTempPackage({
      "registry.ts": `
        function createAcpHarness(input) { return input; }
        export const DEMO_REGISTRY = {
          alpha: createAcpHarness({
            id: "alpha",
            displayName: "Alpha",
            description: "First runtime.",
            command: "alpha-bin",
            install: { installHint: "brew install alpha" },
          }),
          beta: createAcpHarness({
            id: "beta",
            displayName: "Beta",
            description: "Second runtime.",
          }),
        };
      `,
    });
    try {
      const rows = getRuntimeRegistryMatrix(srcDir, "DEMO_REGISTRY");
      expect(rows).toEqual([
        {
          id: "alpha",
          displayName: "Alpha",
          description: "First runtime.",
          command: "alpha-bin",
          install: "brew install alpha",
        },
        { id: "beta", displayName: "Beta", description: "Second runtime." },
      ]);
    } finally {
      cleanup();
    }
  });

  test("throws when the registry is missing required displayName", () => {
    const { srcDir, cleanup } = makeTempPackage({
      "registry.ts": `
        function createAcpHarness(input) { return input; }
        export const DEMO_REGISTRY = {
          alpha: createAcpHarness({ id: "alpha", description: "No displayName." }),
        };
      `,
    });
    try {
      expect(() => getRuntimeRegistryMatrix(srcDir, "DEMO_REGISTRY")).toThrow(
        /missing required displayName/,
      );
    } finally {
      cleanup();
    }
  });

  test("throws when the registry symbol is not declared anywhere under srcDir", () => {
    const { srcDir, cleanup } = makeTempPackage({
      "registry.ts": `export const SOMETHING_ELSE = {};`,
    });
    try {
      expect(() => getRuntimeRegistryMatrix(srcDir, "GHOST_REGISTRY")).toThrow(
        /variable "GHOST_REGISTRY" not found/,
      );
    } finally {
      cleanup();
    }
  });
});

describe("getMethodKeyedRegistryEntries", () => {
  test("happy path: walks toSchemaInfoMap(<source>.<key>) and returns sorted (method, schemaName) pairs", () => {
    const { srcDir, cleanup } = makeTempPackage({
      "schemas.ts": `
        export const sourceArtifacts = {
          requestSchemas: {
            ping: { method: "ping", definitionName: "PingRequest" },
            doStuff: { method: "doStuff", definitionName: "DoStuffRequest" },
          },
        } as const;
        function toSchemaInfoMap(input) { return new Map(); }
        export const fooSchemas = toSchemaInfoMap(sourceArtifacts.requestSchemas);
      `,
    });
    try {
      const entries = getMethodKeyedRegistryEntries(srcDir, "fooSchemas");
      expect(entries).toEqual([
        { method: "doStuff", schemaName: "DoStuffRequest" },
        { method: "ping", schemaName: "PingRequest" },
      ]);
    } finally {
      cleanup();
    }
  });

  test("throws when the call argument is not a property access expression", () => {
    const { srcDir, cleanup } = makeTempPackage({
      "schemas.ts": `
        function toSchemaInfoMap(input) { return new Map(); }
        export const fooSchemas = toSchemaInfoMap("just a string");
      `,
    });
    try {
      expect(() => getMethodKeyedRegistryEntries(srcDir, "fooSchemas")).toThrow(
        /argument is .*, expected PropertyAccessExpression/,
      );
    } finally {
      cleanup();
    }
  });

  test("throws when an entry value is missing the definitionName property", () => {
    const { srcDir, cleanup } = makeTempPackage({
      "schemas.ts": `
        export const sourceArtifacts = {
          requestSchemas: {
            ping: { method: "ping" },
          },
        } as const;
        function toSchemaInfoMap(input) { return new Map(); }
        export const fooSchemas = toSchemaInfoMap(sourceArtifacts.requestSchemas);
      `,
    });
    try {
      expect(() => getMethodKeyedRegistryEntries(srcDir, "fooSchemas")).toThrow(
        /entry has no 'definitionName' property/,
      );
    } finally {
      cleanup();
    }
  });
});
