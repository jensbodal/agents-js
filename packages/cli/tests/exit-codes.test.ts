import { describe, expect, test } from "bun:test";
import {
  EXIT_AUTH_REQUIRED,
  EXIT_DATAERR,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_PROTOCOL_CONTAMINATION,
  EXIT_USAGE,
} from "../src/exit-codes.ts";

describe("exit codes", () => {
  test("each constant has its documented numeric value", () => {
    // WHAT: pin the wire-level numbers so subcommand contracts and shell
    // callers don't drift if someone refactors the centralized module.
    // WHY: these codes appear in operator scripts and test assertions
    // across the workspace; a silent renumber would corrupt automation.
    expect(EXIT_OK).toBe(0);
    expect(EXIT_ERROR).toBe(1);
    expect(EXIT_USAGE).toBe(64);
    expect(EXIT_DATAERR).toBe(65);
    expect(EXIT_PROTOCOL_CONTAMINATION).toBe(70);
    expect(EXIT_AUTH_REQUIRED).toBe(71);
  });
});
