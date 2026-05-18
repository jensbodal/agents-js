import { describe, expect, test } from "bun:test";
import pkgRaw from "../package.json" with { type: "json" };

interface PackageManifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const pkg = pkgRaw as PackageManifest;

describe("@agents-js/canvas-model — leaf package posture", () => {
  // What: the canvas model package has no runtime, renderer, or storage dependencies.
  // Why: the model is intended to stay usable by hosts, reporting, and adapters without dragging in UI/runtime code.
  test("declares no runtime dependencies", () => {
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
    expect(pkg.optionalDependencies ?? {}).toEqual({});
  });
});
