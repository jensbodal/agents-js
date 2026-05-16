import { describe, expect, it } from "bun:test";
import pkgRaw from "../package.json" with { type: "json" };

interface PackageManifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}
const pkg = pkgRaw as PackageManifest;

const FORBIDDEN_DEP_PREFIXES = [
  "@modelcontextprotocol/",
  "openmemory-",
  "cognee-",
  "@cognee/",
  "agents-js/cognee",
];

describe("@agents-js/memory — library-agnostic posture", () => {
  it("declares no backend-coupled dependencies", () => {
    const allDeps = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]);

    const violations = [...allDeps].filter((name) =>
      FORBIDDEN_DEP_PREFIXES.some((prefix) => name.startsWith(prefix)),
    );

    expect(violations).toEqual([]);
  });

  it("declares no runtime dependencies at all (primitive-only)", () => {
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
