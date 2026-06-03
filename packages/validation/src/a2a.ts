import { AgentCard } from "@a2a-js/sdk";
import { ValidationError } from "./errors.ts";
import type { ValidationOptions } from "./modes.ts";

/**
 * Validate an A2A AgentCard against the SDK's canonical proto shape.
 *
 * Forward-only (A2A 1.0): the hand-rolled 0.3-wire AJV schemas were deleted —
 * the gateway server now relies on the SDK's `JsonRpcTransportHandler.handle()`
 * for envelope validation, so the standalone request/response validators are
 * obsolete. AgentCard validation remains a public surface (a2a-client depends
 * on it), reimplemented as a thin wrapper over `AgentCard.fromJSON`.
 *
 * `AgentCard` is a declaration-merged value+type from "@a2a-js/sdk"; the value
 * side exposes `fromJSON`, which is lenient (fills proto defaults) and never
 * itself throws, so the only hard rejection here is the non-object guard. The
 * `options` parameter is preserved for signature stability with the prior AJV
 * implementation but has no mode behavior under the SDK-backed wrapper.
 */
export function validateAgentCard(input: unknown, _options: ValidationOptions = {}): AgentCard {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ValidationError("AgentCard must be a non-null object", {
      field: "agentCard",
      value: input,
      issues: [{ path: "agentCard", message: "Expected a non-null object" }],
    });
  }

  try {
    return AgentCard.fromJSON(input);
  } catch (error) {
    throw new ValidationError(
      `Invalid AgentCard: ${error instanceof Error ? error.message : String(error)}`,
      {
        field: "agentCard",
        value: input,
        issues: [
          {
            path: "agentCard",
            message: error instanceof Error ? error.message : "Invalid AgentCard",
          },
        ],
      },
    );
  }
}
