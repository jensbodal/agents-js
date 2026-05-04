import { describe, expect, test } from "bun:test";
import { createParseEnv, EnvError, parseEnv } from "@agents-js/gateway-runtime";

// Use createParseEnv with static sources so tests don't depend on process.env state.

describe("parseEnv", () => {
  describe("required string", () => {
    test("returns value when set", () => {
      const parse = createParseEnv({ MY_VAR: "hello" });
      expect(parse("MY_VAR").string()).toBe("hello");
    });

    test("throws EnvError when missing", () => {
      const parse = createParseEnv({});
      expect(() => parse("MY_VAR").string()).toThrow(EnvError);
      expect(() => parse("MY_VAR").string()).toThrow("is required but not set");
    });

    test("throws EnvError when explicitly undefined", () => {
      const parse = createParseEnv({ MY_VAR: undefined });
      expect(() => parse("MY_VAR").string()).toThrow(EnvError);
    });

    test("uses default value when var is missing", () => {
      const parse = createParseEnv({});
      expect(parse("MY_VAR", "fallback").string()).toBe("fallback");
    });

    test("env value takes precedence over default", () => {
      const parse = createParseEnv({ MY_VAR: "actual" });
      expect(parse("MY_VAR", "fallback").string()).toBe("actual");
    });

    test("returns empty string when set to empty", () => {
      const parse = createParseEnv({ MY_VAR: "" });
      expect(parse("MY_VAR").string()).toBe("");
    });

    test("preserves whitespace-only strings", () => {
      const parse = createParseEnv({ MY_VAR: "   " });
      expect(parse("MY_VAR").string()).toBe("   ");
    });
  });

  describe("optional string", () => {
    test("returns value when set", () => {
      const parse = createParseEnv({ MY_VAR: "world" });
      expect(parse("MY_VAR").optional().string()).toBe("world");
    });

    test("returns undefined when missing", () => {
      const parse = createParseEnv({});
      expect(parse("MY_VAR").optional().string()).toBeUndefined();
    });
  });

  describe("number", () => {
    test("parses valid integer", () => {
      const parse = createParseEnv({ PORT: "3000" });
      expect(parse("PORT").number()).toBe(3000);
    });

    test("parses valid float", () => {
      const parse = createParseEnv({ RATE: "0.75" });
      expect(parse("RATE").number()).toBe(0.75);
    });

    test("parses zero", () => {
      const parse = createParseEnv({ PORT: "0" });
      expect(parse("PORT").number()).toBe(0);
    });

    test("parses negative numbers", () => {
      const parse = createParseEnv({ OFFSET: "-42" });
      expect(parse("OFFSET").number()).toBe(-42);
    });

    test("throws on non-numeric value", () => {
      const parse = createParseEnv({ PORT: "abc" });
      expect(() => parse("PORT").number()).toThrow(EnvError);
      expect(() => parse("PORT").number()).toThrow('cannot parse "abc" as number');
    });

    test("rejects NaN string", () => {
      const parse = createParseEnv({ PORT: "NaN" });
      expect(() => parse("PORT").number()).toThrow(EnvError);
    });

    test("uses default for missing var", () => {
      const parse = createParseEnv({});
      expect(parse("PORT", "8080").number()).toBe(8080);
    });

    test("optional returns undefined when missing", () => {
      const parse = createParseEnv({});
      expect(parse("PORT").optional().number()).toBeUndefined();
    });

    test("optional parses when present", () => {
      const parse = createParseEnv({ PORT: "443" });
      expect(parse("PORT").optional().number()).toBe(443);
    });
  });

  describe("boolean", () => {
    test.each([
      ["true", true],
      ["1", true],
      ["yes", true],
      ["on", true],
      ["TRUE", true],
      ["Yes", true],
      ["false", false],
      ["0", false],
      ["no", false],
      ["off", false],
      ["FALSE", false],
      ["", false],
    ])('parses "%s" as %p', (input, expected) => {
      const parse = createParseEnv({ FLAG: input });
      expect(parse("FLAG").boolean()).toBe(expected);
    });

    test("throws on invalid boolean value", () => {
      const parse = createParseEnv({ FLAG: "maybe" });
      expect(() => parse("FLAG").boolean()).toThrow(EnvError);
      expect(() => parse("FLAG").boolean()).toThrow("cannot parse");
    });

    test("optional returns undefined when missing", () => {
      const parse = createParseEnv({});
      expect(parse("FLAG").optional().boolean()).toBeUndefined();
    });

    test("optional parses when present", () => {
      const parse = createParseEnv({ DEBUG: "true" });
      expect(parse("DEBUG").optional().boolean()).toBe(true);
    });
  });

  describe("EnvError", () => {
    test("includes variable name", () => {
      const parse = createParseEnv({});
      try {
        parse("SECRET_KEY").string();
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(EnvError);
        expect((e as EnvError).variable).toBe("SECRET_KEY");
      }
    });
  });

  describe("createParseEnv", () => {
    test("isolates source from process.env", () => {
      const source = { CUSTOM: "value" };
      const parse = createParseEnv(source);
      expect(parse("CUSTOM").string()).toBe("value");
      // Doesn't leak into process.env
      expect(parse("PATH").optional().string()).toBeUndefined();
    });
  });

  describe("default parseEnv reads process.env", () => {
    test("reads from process.env", () => {
      const key = `AJS_TEST_PARSE_ENV_${Date.now()}`;
      process.env[key] = "from-process-env";
      try {
        expect(parseEnv(key).string()).toBe("from-process-env");
      } finally {
        delete process.env[key];
      }
    });
  });
});
