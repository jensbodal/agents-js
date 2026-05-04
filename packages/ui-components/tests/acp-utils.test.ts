import { describe, expect, test } from "bun:test";
import { statusCategory } from "../src/acp-utils.ts";

describe("statusCategory", () => {
  test("connected -> success", () => {
    expect(statusCategory("connected")).toBe("success");
  });

  test("completed -> success", () => {
    expect(statusCategory("completed")).toBe("success");
  });

  test("error -> error", () => {
    expect(statusCategory("error")).toBe("error");
  });

  test("sending -> active", () => {
    expect(statusCategory("sending")).toBe("active");
  });

  test("waiting -> active", () => {
    expect(statusCategory("waiting")).toBe("active");
  });

  test("connecting -> active", () => {
    expect(statusCategory("connecting")).toBe("active");
  });

  test("input_required -> active", () => {
    expect(statusCategory("input_required")).toBe("active");
  });

  test("auth_required -> active", () => {
    expect(statusCategory("auth_required")).toBe("active");
  });

  test("idle -> idle", () => {
    expect(statusCategory("idle")).toBe("idle");
  });

  test("unknown string -> idle", () => {
    expect(statusCategory("something_else")).toBe("idle");
  });
});
