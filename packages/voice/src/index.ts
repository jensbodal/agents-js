/**
 * Voice M2 text seams for agents-js.
 *
 * agents-js owns a narrow waist of the voice pipeline: the named A2A target
 * and the two text normalizers around it. Speech-to-text (Whisper), the TTS
 * audio (Kokoro) and the media transport (LiveKit / MatrixRTC) live in the
 * integration layer, not here.
 *
 * - **transcript-in** has two halves: the text is read with `getMessageText()`
 *   from `@agents-js/a2a`, and the segment descriptor with {@link readVoiceMetadata}.
 *   M1 emits fixed 5-second windows (not utterance boundaries), so an inbound
 *   message is one window and may bisect a sentence; the
 *   `voice.segmentation: "fixed-window"` metadata key signals that granularity.
 * - **response-out** is {@link toSpeakableText}: it turns an agent's reply —
 *   which is typically Markdown — into clean prose a TTS engine can read aloud.
 *
 * @module
 */

export {
  buildVoiceMetadata,
  readVoiceMetadata,
  VOICE_FINAL_KEY,
  VOICE_SEGMENTATION_KEY,
  VOICE_SPEAKER_KEY,
  VOICE_TURN_ID_KEY,
  type VoiceSegmentation,
  type VoiceTurnMetadata,
} from "./metadata.ts";

/** Matches a fenced code block (```lang ... ```), including the fences. */
const FENCED_CODE = /```[\s\S]*?```/g;
/** Matches a Markdown image: ![alt](url). Dropped entirely — not speakable. */
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
/** Matches a Markdown link: [text](url). Keeps the text, drops the URL. */
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
/** Matches inline code: `text`. Keeps the inner text. */
const INLINE_CODE = /`([^`]*)`/g;
/** Matches a leading heading marker (#, ##, …) at the start of a line. */
const HEADING = /^[ \t]*#{1,6}[ \t]+/gm;
/** Matches a leading blockquote marker (>) at the start of a line. */
const BLOCKQUOTE = /^[ \t]*>[ \t]?/gm;
/** Matches a horizontal rule line (---, ***, ___). */
const HORIZONTAL_RULE = /^[ \t]*([-*_])\1{2,}[ \t]*$/gm;
/** Matches a leading unordered-list bullet (-, *, +) at the start of a line. */
const UNORDERED_BULLET = /^[ \t]*[-*+][ \t]+/gm;
/** Matches a leading ordered-list number (1., 2., …) at the start of a line. */
const ORDERED_BULLET = /^[ \t]*\d+\.[ \t]+/gm;
/** Matches ***bold-italic*** / ___bold-italic___ emphasis wrappers. */
const EMPHASIS_TRIPLE = /(\*\*\*|___)(.+?)\1/g;
/** Matches **bold** / __bold__ emphasis wrappers. */
const EMPHASIS_DOUBLE = /(\*\*|__)(.+?)\1/g;
/** Matches *italic* / _italic_ emphasis wrappers. */
const EMPHASIS_SINGLE = /(\*|_)(.+?)\1/g;
/** Matches any run of whitespace (including newlines). */
const WHITESPACE_RUN = /\s+/g;

/**
 * Normalize an agent's (typically Markdown) reply into a single line of plain
 * prose suitable for a text-to-speech engine.
 *
 * Speech-oriented rules:
 * - Fenced code blocks are dropped entirely (reading code aloud is noise).
 * - Inline code keeps its text (`bun test` → "bun test" — usually a phrase).
 * - Links keep their text and drop the URL; images are dropped entirely.
 * - Heading, blockquote and list markers are stripped, keeping the content.
 * - Horizontal rules are removed.
 * - Bold/italic emphasis markers are stripped, keeping the words.
 * - All whitespace runs (including newlines) collapse to single spaces.
 *
 * The transform never throws and returns `""` for empty or marker-only input.
 *
 * @param input Raw reply text, possibly containing Markdown.
 * @returns A trimmed, single-line, speakable string.
 */
export function toSpeakableText(input: string): string {
  return input
    .replace(FENCED_CODE, " ")
    .replace(IMAGE, "")
    .replace(LINK, "$1")
    .replace(INLINE_CODE, "$1")
    .replace(HEADING, "")
    .replace(BLOCKQUOTE, "")
    .replace(HORIZONTAL_RULE, "")
    .replace(UNORDERED_BULLET, "")
    .replace(ORDERED_BULLET, "")
    .replace(EMPHASIS_TRIPLE, "$2")
    .replace(EMPHASIS_DOUBLE, "$2")
    .replace(EMPHASIS_SINGLE, "$2")
    .replace(WHITESPACE_RUN, " ")
    .trim();
}
