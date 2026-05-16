import { describe, expect, it } from "bun:test";
import { InMemoryProvider, runProviderConformanceTests } from "../src/testing.ts";

runProviderConformanceTests({
  describe,
  it,
  expect,
  makeProvider: () => new InMemoryProvider(),
});
