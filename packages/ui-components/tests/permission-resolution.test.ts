import { describe, expect, test } from "bun:test";
import { createPermissionResolution } from "../src/permission-resolution.ts";

describe("createPermissionResolution", () => {
  test("converts selected modal details into the gateway wire shape", () => {
    expect(
      createPermissionResolution({
        outcome: "selected",
        optionId: "allow-1",
        selectedScope: "/workspace/docs/",
      }),
    ).toEqual({
      response: {
        outcome: {
          outcome: "selected",
          optionId: "allow-1",
        },
      },
      selectedScope: "/workspace/docs/",
    });
  });

  test("converts cancelled modal details into the gateway wire shape", () => {
    expect(
      createPermissionResolution({
        outcome: "cancelled",
        selectedScope: "/workspace/docs/",
      }),
    ).toEqual({
      response: {
        outcome: {
          outcome: "cancelled",
        },
      },
      selectedScope: "/workspace/docs/",
    });
  });
});
