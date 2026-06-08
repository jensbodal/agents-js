import { describe, expect, test } from "bun:test";
import { type CompilePlan, resolveCompilePlan } from "../scripts/compile-plan.ts";

describe("resolveCompilePlan", () => {
  test("host-default build on darwin: no --target, signs", () => {
    const plan = resolveCompilePlan(undefined, "darwin");
    expect(plan.compileArgs).toEqual([]);
    expect(plan.shouldSign).toBe(true);
  });

  test("host-default build on linux: no --target, does not sign", () => {
    const plan = resolveCompilePlan(undefined, "linux");
    expect(plan.compileArgs).toEqual([]);
    expect(plan.shouldSign).toBe(false);
  });

  test("explicit linux target never signs — even built on a darwin host (the ENOEXEC fix)", () => {
    // The 2026-06-08 outage class: a Linux binary must not be handed to
    // `codesign`, regardless of the host doing the cross-build.
    for (const host of ["darwin", "linux"] as const) {
      const plan = resolveCompilePlan("bun-linux-x64", host);
      expect(plan.compileArgs).toEqual(["--target", "bun-linux-x64"]);
      expect(plan.shouldSign).toBe(false);
    }
  });

  test("musl and arm64 linux targets are recognized as non-darwin", () => {
    for (const target of ["bun-linux-x64-musl", "bun-linux-arm64", "bun-linux-arm64-musl"]) {
      const plan = resolveCompilePlan(target, "darwin");
      expect(plan.shouldSign).toBe(false);
      expect(plan.compileArgs).toEqual(["--target", target]);
    }
  });

  test("explicit darwin targets sign, from any host", () => {
    for (const target of ["bun-darwin-arm64", "bun-darwin-x64"]) {
      const plan = resolveCompilePlan(target, "linux");
      expect(plan.compileArgs).toEqual(["--target", target]);
      expect(plan.shouldSign).toBe(true);
    }
  });

  test("blank / whitespace target falls back to the host-default branch", () => {
    for (const blank of ["", "   "]) {
      const plan = resolveCompilePlan(blank, "linux");
      expect(plan.compileArgs).toEqual([]);
      expect(plan.shouldSign).toBe(false);
    }
  });

  test("targetLabel describes the resolved target for build logs", () => {
    const host: CompilePlan = resolveCompilePlan(undefined, "linux");
    expect(host.targetLabel).toBe("host (linux)");
    const cross: CompilePlan = resolveCompilePlan("bun-linux-x64", "darwin");
    expect(cross.targetLabel).toBe("bun-linux-x64");
  });
});
