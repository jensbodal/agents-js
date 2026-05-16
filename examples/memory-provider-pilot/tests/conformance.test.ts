import { describe, expect, it } from "bun:test";
import { runProviderConformanceTests } from "@agents-js/memory/testing";
import { MapBackedProvider } from "../src/map-backed-provider.ts";

runProviderConformanceTests({
  describe,
  it,
  expect,
  makeProvider: () => new MapBackedProvider(),
});
