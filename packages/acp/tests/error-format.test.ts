import { describe, expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { extractRequestErrorDetails, formatRequestError } from "../src/error-format.ts";

describe("formatRequestError", () => {
  test("returns String(error) for non-Error values", () => {
    expect(formatRequestError("oops")).toBe("oops");
    expect(formatRequestError(42)).toBe("42");
    expect(formatRequestError(null)).toBe("null");
    expect(formatRequestError(undefined)).toBe("undefined");
  });

  test("returns error.message for plain Error without data", () => {
    expect(formatRequestError(new Error("plain"))).toBe("plain");
  });

  test("returns error.message when data is empty or missing", () => {
    const withoutData = new RequestError(-32603, "Internal error");
    expect(formatRequestError(withoutData)).toBe("Internal error");

    const withEmptyObject = new RequestError(-32603, "Internal error", {});
    expect(formatRequestError(withEmptyObject)).toBe("Internal error");
  });

  test("appends data.details from RequestError", () => {
    const err = new RequestError(-32603, "Internal error", {
      details: 'default agent "Sisyphus - Ultraworker" not found',
    });
    expect(formatRequestError(err)).toBe(
      'Internal error: default agent "Sisyphus - Ultraworker" not found',
    );
  });

  test("falls back to data.message when details is absent", () => {
    const err = new RequestError(-32602, "Invalid params", {
      message: "missing required field 'cwd'",
    });
    expect(formatRequestError(err)).toBe("Invalid params: missing required field 'cwd'");
  });

  test("handles string data field", () => {
    // Manually construct to simulate an SDK that passes a string through.
    const err = Object.assign(new Error("Auth required"), {
      code: -32001,
      data: "password expired",
    });
    expect(formatRequestError(err)).toBe("Auth required: password expired");
  });

  test("stringifies data as fallback for non-empty opaque objects", () => {
    const err = new RequestError(-32603, "Internal error", { foo: "bar", n: 1 });
    expect(formatRequestError(err)).toBe('Internal error: {"foo":"bar","n":1}');
  });

  test("does not duplicate when details equals message", () => {
    const err = new RequestError(-32603, "Internal error", { details: "Internal error" });
    expect(formatRequestError(err)).toBe("Internal error");
  });

  test("stringifies object with whitespace-only details as fallback", () => {
    // Whitespace-only details is rejected, but the object itself is still
    // non-empty, so JSON.stringify fallback applies. Callers who care about
    // pure-whitespace semantics should filter upstream.
    const err = new RequestError(-32603, "Internal error", { details: "   " });
    expect(formatRequestError(err)).toBe('Internal error: {"details":"   "}');
  });

  test("handles cyclic data without throwing", () => {
    const cyclic: Record<string, unknown> = { foo: "bar" };
    cyclic.self = cyclic;
    const err = Object.assign(new Error("cycle"), { code: -1, data: cyclic });
    // Falls back to error.message — JSON.stringify would throw, formatter swallows.
    expect(formatRequestError(err)).toBe("cycle");
  });
});

describe("extractRequestErrorDetails", () => {
  test("returns undefined for non-object errors", () => {
    expect(extractRequestErrorDetails("string")).toBeUndefined();
    expect(extractRequestErrorDetails(42)).toBeUndefined();
    expect(extractRequestErrorDetails(null)).toBeUndefined();
  });

  test("returns undefined when data is absent", () => {
    expect(extractRequestErrorDetails(new Error("plain"))).toBeUndefined();
  });

  test("extracts details string from data object", () => {
    const err = new RequestError(-32603, "x", { details: "useful context" });
    expect(extractRequestErrorDetails(err)).toBe("useful context");
  });
});
