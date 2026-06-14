import { describe, expect, test } from "bun:test";
import { buildVoiceMetadata, readVoiceMetadata } from "../src/index.ts";

describe("readVoiceMetadata", () => {
  test("returns undefined for non-record input", () => {
    expect(readVoiceMetadata(undefined)).toBeUndefined();
    expect(readVoiceMetadata(null)).toBeUndefined();
    expect(readVoiceMetadata("voice")).toBeUndefined();
    expect(readVoiceMetadata(["voice.final"])).toBeUndefined();
  });

  test("returns undefined for a record with no voice.* keys", () => {
    expect(readVoiceMetadata({ "acp.auth-required": {} })).toBeUndefined();
    expect(readVoiceMetadata({})).toBeUndefined();
  });

  test("reads all four fields when present", () => {
    expect(
      readVoiceMetadata({
        "voice.speaker": "jens",
        "voice.turnId": "abc-123",
        "voice.final": true,
        "voice.segmentation": "fixed-window",
      }),
    ).toEqual({
      speaker: "jens",
      turnId: "abc-123",
      final: true,
      segmentation: "fixed-window",
    });
  });

  test("recognizes a voice message from any single voice.* key", () => {
    expect(readVoiceMetadata({ "voice.speaker": "jens" })).toEqual({
      speaker: "jens",
      final: false,
      segmentation: "fixed-window",
    });
  });

  test("defaults segmentation to fixed-window when the key is absent", () => {
    const result = readVoiceMetadata({ "voice.turnId": "t1", "voice.final": true });
    expect(result?.segmentation).toBe("fixed-window");
  });

  test("defaults final to false when the key is absent", () => {
    const result = readVoiceMetadata({ "voice.turnId": "t1" });
    expect(result?.final).toBe(false);
  });

  test("coerces an unknown segmentation value to fixed-window", () => {
    const result = readVoiceMetadata({
      "voice.turnId": "t1",
      "voice.segmentation": "semantic-turn",
    });
    expect(result?.segmentation).toBe("fixed-window");
  });

  test("preserves the utterance segmentation value", () => {
    const result = readVoiceMetadata({
      "voice.turnId": "t1",
      "voice.segmentation": "utterance",
    });
    expect(result?.segmentation).toBe("utterance");
  });

  test("ignores non-string speaker and turnId", () => {
    const result = readVoiceMetadata({
      "voice.speaker": 42,
      "voice.turnId": { id: 1 },
      "voice.final": true,
    });
    expect(result).toEqual({ final: true, segmentation: "fixed-window" });
  });

  test("ignores a non-boolean final", () => {
    const result = readVoiceMetadata({ "voice.turnId": "t1", "voice.final": "yes" });
    expect(result?.final).toBe(false);
  });
});

describe("buildVoiceMetadata", () => {
  test("round-trips through readVoiceMetadata", () => {
    const built = buildVoiceMetadata({
      speaker: "jens",
      turnId: "abc-123",
      final: true,
      segmentation: "fixed-window",
    });
    expect(readVoiceMetadata(built)).toEqual({
      speaker: "jens",
      turnId: "abc-123",
      final: true,
      segmentation: "fixed-window",
    });
  });

  test("omits undefined speaker and turnId", () => {
    const built = buildVoiceMetadata({ final: true, segmentation: "fixed-window" });
    expect(built).toEqual({
      "voice.final": true,
      "voice.segmentation": "fixed-window",
    });
  });

  test("defaults segmentation to fixed-window when omitted", () => {
    const built = buildVoiceMetadata({ final: false });
    expect(built["voice.segmentation"]).toBe("fixed-window");
  });
});
