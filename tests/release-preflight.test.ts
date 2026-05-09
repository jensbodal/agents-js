import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { publishPackageName } from "../scripts/release-config.ts";
import {
  type AuditedPackage,
  auditReleaseSurface,
  collectInternalDependencyIssues,
  collectPublishOrderIssues,
  computePublishOrder,
  parseScopedRegistryFromNpmrc,
} from "../scripts/release-preflight.ts";

const repoRoot = path.resolve(import.meta.dir, "..");

function makePackage(dirName: string, manifest: AuditedPackage["manifest"]): AuditedPackage {
  return {
    dirName,
    manifest,
    manifestPath: path.join("/tmp", dirName, "package.json"),
  };
}

describe("release preflight helpers", () => {
  test("parseScopedRegistryFromNpmrc reads the scoped registry without touching credentials", () => {
    const registry = parseScopedRegistryFromNpmrc(`
# comment
@agents-js:registry=https://registry.example.invalid/npm/
registry=https://registry.npmjs.org/
//registry.example.invalid/npm/:_authToken=redacted
`);

    expect(registry).toBe("https://registry.example.invalid/npm/");
  });

  test("parseScopedRegistryFromNpmrc honors the last matching scope entry", () => {
    const registry = parseScopedRegistryFromNpmrc(`
@agents-js:registry=https://registry.first.invalid/npm/
@agents-js:registry=https://registry.last.invalid/npm/
`);

    expect(registry).toBe("https://registry.last.invalid/npm/");
  });

  test("parseScopedRegistryFromNpmrc returns null when no scoped registry is declared", () => {
    const registry = parseScopedRegistryFromNpmrc(`
# scope-free .npmrc — intentional for OSS publication
registry=https://registry.npmjs.org/
`);

    expect(registry).toBeNull();
  });

  test("collectInternalDependencyIssues flags workspace, file, and wrong-version specs", () => {
    const pkg = makePackage("cli", {
      name: "@agents-js/cli",
      version: "1.2.3",
      dependencies: {
        "@agents-js/acp": "workspace:*",
        "@agents-js/acp-host": "file:../acp-host",
        "@agents-js/policy": "1.2.2",
      },
    });

    const issues = collectInternalDependencyIssues(
      pkg,
      "1.2.3",
      new Set(["@agents-js/acp", "@agents-js/acp-host", "@agents-js/policy"]),
    );

    expect(issues).toEqual([
      "@agents-js/cli: dependencies.@agents-js/acp uses workspace:*; publishable packages must use exact released versions",
      "@agents-js/cli: dependencies.@agents-js/acp-host uses file:../acp-host; publishable packages must use exact released versions",
      "@agents-js/cli: dependencies.@agents-js/policy=1.2.2 does not match release version 1.2.3",
    ]);
  });

  test("computePublishOrder topologically sorts internal package dependencies", () => {
    const order = computePublishOrder([
      makePackage("cli", {
        name: publishPackageName("cli"),
        version: "1.2.3",
        dependencies: {
          "@agents-js/acp": "1.2.3",
        },
      }),
      makePackage("acp", {
        name: publishPackageName("acp"),
        version: "1.2.3",
      }),
      makePackage("policy", {
        name: publishPackageName("policy"),
        version: "1.2.3",
      }),
    ]);

    expect(order.indexOf("acp")).toBeLessThan(order.indexOf("cli"));
    expect(order).toContain("policy");
  });

  test("collectPublishOrderIssues flags publishable dependency cycles", () => {
    const issues = collectPublishOrderIssues([
      makePackage("acp", {
        name: publishPackageName("acp"),
        version: "1.2.3",
        dependencies: {
          "@agents-js/cli": "1.2.3",
        },
      }),
      makePackage("cli", {
        name: publishPackageName("cli"),
        version: "1.2.3",
        dependencies: {
          "@agents-js/acp": "1.2.3",
        },
      }),
    ]);

    expect(issues).toEqual([
      "Publish order contains a dependency cycle among publishable package directories: acp, cli",
    ]);
  });

  test("the current repo passes release audit without requiring local npm credentials", async () => {
    const rootManifestPath = path.join(repoRoot, "package.json");
    const rootManifest = JSON.parse(await readFile(rootManifestPath, "utf8")) as {
      version: string;
      agentsJs: { externalSDKs: Record<string, string> };
    };
    const configuredVersions = {
      release: rootManifest.version,
      externalSDKs: rootManifest.agentsJs.externalSDKs,
    };
    const result = await auditReleaseSurface({
      repoRoot,
      requireNpmrc: false,
    });

    expect(result.issues).toEqual([]);
    expect(result.releaseVersion).toBe(configuredVersions.release);
    expect(result.publishOrder.length).toBeGreaterThan(0);
  });
});
