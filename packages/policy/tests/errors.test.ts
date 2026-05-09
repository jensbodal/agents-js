import { describe, expect, test } from "bun:test";
import { policyError, validationError } from "../src/errors.ts";

// JSON-RPC reserved server-error range: -32099 .. -32000 (per the spec).
const SERVER_ERROR_RANGE_MIN = -32099;
const SERVER_ERROR_RANGE_MAX = -32000;

// JSON-RPC standard error codes that hosts care about.
const INVALID_PARAMS = -32602; // pinned to the spec, not to our implementation.
const INVALID_REQUEST = -32600;
const PARSE_ERROR = -32700;

describe("policyError", () => {
  test("returns a code in the JSON-RPC reserved server-error range", () => {
    const code = policyError("blocked").code;
    expect(code).toBeGreaterThanOrEqual(SERVER_ERROR_RANGE_MIN);
    expect(code).toBeLessThanOrEqual(SERVER_ERROR_RANGE_MAX);
  });

  test("does not collide with JSON-RPC reserved standard codes", () => {
    const code = policyError("any").code;
    expect(code).not.toBe(INVALID_REQUEST);
    expect(code).not.toBe(INVALID_PARAMS);
    expect(code).not.toBe(PARSE_ERROR);
  });

  test("passes the reason through verbatim as the message", () => {
    expect(policyError("operation-not-allowed").message).toBe("operation-not-allowed");
  });
});

describe("validationError", () => {
  test("uses the JSON-RPC standard invalid-params code", () => {
    expect(validationError("bad input").code).toBe(INVALID_PARAMS);
  });

  test("passes the reason through verbatim as the message", () => {
    expect(validationError("missing field").message).toBe("missing field");
  });
});

describe("policyError vs validationError", () => {
  test("produce distinct codes so callers can route on them", () => {
    expect(policyError("x").code).not.toBe(validationError("x").code);
  });
});
