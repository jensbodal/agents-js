/**
 * Voice turn metadata carried on an A2A message's `metadata` record.
 *
 * The voice transcript text travels in `message.parts` (read with
 * `getMessageText()` from `@agents-js/a2a`); this module covers the parallel
 * `message.metadata` channel that describes *what kind of segment* the text is.
 *
 * The segmentation field is the load-bearing one. M1 emits fixed 5-second
 * windows, not finalized utterances — a message may bisect a sentence. M2 must
 * not silently assume clean turn boundaries, so the contract carries an
 * explicit `voice.segmentation` discriminator. Real VAD/utterance segmentation
 * arrives with M3; until then the conservative reading is `"fixed-window"`.
 *
 * @module
 */

/**
 * Namespaced metadata keys for the voice turn contract.
 *
 * `voice.speaker` carries the full MatrixRTC participant identity — the
 * Matrix user ID followed by `:DEVICE`, e.g.
 * `@jensbodal:matrix.example.net:DWPXXJETUG` — not a bare localpart. The
 * M1→A2A wiring fills it with that exact format so consumers can key on a
 * stable, device-scoped identity.
 */
export const VOICE_SPEAKER_KEY = "voice.speaker";
export const VOICE_TURN_ID_KEY = "voice.turnId";
export const VOICE_FINAL_KEY = "voice.final";
export const VOICE_SEGMENTATION_KEY = "voice.segmentation";

/**
 * How an inbound voice message was segmented.
 *
 * - `"fixed-window"` — a fixed time slice (M1's 5s windows); may bisect a
 *   sentence. The conservative default when the producer is silent.
 * - `"utterance"` — a VAD/turn-detected semantic unit (M3 and later).
 */
export type VoiceSegmentation = "fixed-window" | "utterance";

const KNOWN_SEGMENTATIONS: ReadonlySet<VoiceSegmentation> = new Set(["fixed-window", "utterance"]);

/**
 * A decoded voice turn descriptor. `final` and `segmentation` are always
 * present (defaulted conservatively) once a message is recognized as voice;
 * `speaker` and `turnId` are optional identifiers.
 */
export interface VoiceTurnMetadata {
  speaker?: string;
  turnId?: string;
  /** Whether this segment is complete. For `fixed-window`, "window complete". */
  final: boolean;
  segmentation: VoiceSegmentation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVoiceSegmentation(value: unknown): value is VoiceSegmentation {
  return typeof value === "string" && KNOWN_SEGMENTATIONS.has(value as VoiceSegmentation);
}

/**
 * Decode the voice turn descriptor from an A2A message's `metadata` record.
 *
 * Returns `undefined` when the input is not a record or carries none of the
 * `voice.*` keys — i.e. this is not a voice message. Once any voice key is
 * present, the safety-relevant fields are filled with conservative defaults:
 * `final` → `false`, `segmentation` → `"fixed-window"`. An unrecognized
 * segmentation string is narrowed to `"fixed-window"` rather than trusted.
 *
 * @param metadata The `message.metadata` value (typed `unknown`).
 * @returns The decoded descriptor, or `undefined` if not a voice message.
 */
export function readVoiceMetadata(metadata: unknown): VoiceTurnMetadata | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }

  const hasVoiceKey =
    VOICE_SPEAKER_KEY in metadata ||
    VOICE_TURN_ID_KEY in metadata ||
    VOICE_FINAL_KEY in metadata ||
    VOICE_SEGMENTATION_KEY in metadata;
  if (!hasVoiceKey) {
    return undefined;
  }

  const speaker = metadata[VOICE_SPEAKER_KEY];
  const turnId = metadata[VOICE_TURN_ID_KEY];
  const final = metadata[VOICE_FINAL_KEY];
  const segmentation = metadata[VOICE_SEGMENTATION_KEY];

  return {
    ...(typeof speaker === "string" ? { speaker } : {}),
    ...(typeof turnId === "string" ? { turnId } : {}),
    final: typeof final === "boolean" ? final : false,
    segmentation: isVoiceSegmentation(segmentation) ? segmentation : "fixed-window",
  };
}

/**
 * Encode a voice turn descriptor into a metadata record for an A2A message.
 *
 * The inverse of {@link readVoiceMetadata}: `undefined` `speaker`/`turnId` are
 * omitted, and `segmentation` defaults to `"fixed-window"` when not supplied.
 *
 * @param payload The descriptor to encode (`final` required).
 * @returns A `Record<string, unknown>` suitable for `message.metadata`.
 */
export function buildVoiceMetadata(payload: {
  speaker?: string;
  turnId?: string;
  final: boolean;
  segmentation?: VoiceSegmentation;
}): Record<string, unknown> {
  return {
    ...(payload.speaker !== undefined ? { [VOICE_SPEAKER_KEY]: payload.speaker } : {}),
    ...(payload.turnId !== undefined ? { [VOICE_TURN_ID_KEY]: payload.turnId } : {}),
    [VOICE_FINAL_KEY]: payload.final,
    [VOICE_SEGMENTATION_KEY]: payload.segmentation ?? "fixed-window",
  };
}
