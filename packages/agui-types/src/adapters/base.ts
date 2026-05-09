/**
 * Shared optional fields carried by every AG-UI event (`BaseEventSchema`).
 *
 * Every adapter accepts these and forwards them verbatim. Centralized here so
 * adding a new field to the AG-UI base schema is a one-file change.
 */
export interface AguiBaseEventOptionals {
  timestamp?: number;
  rawEvent?: unknown;
}

/**
 * Return an object containing only the base-event optionals that are defined.
 *
 * Kept out of the returned event unless present so the emitted JSON stays
 * minimal and matches the AG-UI spec's optional-absent convention.
 */
export function pickAguiBaseOptionals(input: AguiBaseEventOptionals): AguiBaseEventOptionals {
  const out: AguiBaseEventOptionals = {};
  if (input.timestamp !== undefined) out.timestamp = input.timestamp;
  if (input.rawEvent !== undefined) out.rawEvent = input.rawEvent;
  return out;
}
