#!/usr/bin/env bun
/**
 * Tiny fixture wrapper used by `wrapper-binary.test.ts` to exercise the
 * `runAcpWrapperBinary` factory end-to-end. Records the forwarded argv to
 * stderr (so it doesn't pollute the NDJSON stdout) before any agent stub
 * is exercised, then yields to the connection — the test drives lifecycle
 * via signals.
 */
import { runAcpWrapperBinary } from "../../src/wrapper-binary.ts";

await runAcpWrapperBinary({
  name: "fixture-acp",
  version: "9.9.9",
  helpText: "fixture help body\n",
  createAgent: (_conn, forwarded) => {
    process.stderr.write(`FORWARDED:${JSON.stringify(forwarded)}\n`);
    return {
      async initialize() {
        return {
          protocolVersion: 1,
          agentInfo: { name: "fixture-acp", version: "9.9.9" },
          agentCapabilities: {},
          authMethods: [],
        };
      },
      async newSession() {
        return { sessionId: "fixture" };
      },
      async prompt() {
        return { stopReason: "end_turn" as const };
      },
      async cancel() {},
      async authenticate() {
        return {};
      },
    };
  },
});
