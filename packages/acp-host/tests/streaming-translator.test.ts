/**
 * Layer 1 — translator unit tests.
 *
 * The `AcpStreamingTranslator` is consumed by both the A2A executor
 * (`@agents-js/a2a`) and the AG-UI handler (`@agents-js/host`). These
 * tests assert the translator's contract independent of either consumer
 * via a `RecordingAcpStreamingSink` test double.
 *
 * Per ACP spec, `agent_message_chunk.content.text` carries the *delta*
 * (not cumulative text). Translator's job is to:
 *   1. Track per-`messageId` accumulated text
 *   2. Surface both `delta` and `cumulativeText` to the sink
 *   3. Detect message boundaries (new `messageId` = new message)
 *   4. Translate `tool_call` / `tool_call_update` to typed sink methods
 *   5. Ignore non-streaming `SessionUpdate` variants
 *
 * No real ACP harness, no LLM. Pure data-in / sink-call-out.
 */
import { describe, expect, test } from "bun:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  type AcpStreamingSink,
  AcpStreamingTranslator,
  type AvailableCommandsUpdateCall,
  type ModeChangeCall,
  type PlanUpdateCall,
  type ToolCallStartCall,
  type ToolCallUpdateCall,
  type UsageUpdateCall,
} from "../src/streaming-translator.ts";

/**
 * Test sink that records every call with arguments. Lets tests assert
 * exact emission order, count, and shape.
 */
class RecordingAcpStreamingSink implements AcpStreamingSink {
  textDeltas: Array<{ messageId: string; delta: string; cumulativeText: string }> = [];
  thoughtDeltas: Array<{ messageId: string; delta: string; cumulativeText: string }> = [];
  toolCallStarts: ToolCallStartCall[] = [];
  toolCallUpdates: ToolCallUpdateCall[] = [];
  planUpdates: PlanUpdateCall[] = [];
  availableCommandsUpdates: AvailableCommandsUpdateCall[] = [];
  modeChanges: ModeChangeCall[] = [];
  usageUpdates: UsageUpdateCall[] = [];

  onTextDelta(input: { messageId: string; delta: string; cumulativeText: string }): void {
    this.textDeltas.push({ ...input });
  }
  onThoughtDelta(input: { messageId: string; delta: string; cumulativeText: string }): void {
    this.thoughtDeltas.push({ ...input });
  }
  onToolCallStart(input: ToolCallStartCall): void {
    this.toolCallStarts.push({ ...input });
  }
  onToolCallUpdate(input: ToolCallUpdateCall): void {
    this.toolCallUpdates.push({ ...input });
  }
  onPlanUpdate(input: PlanUpdateCall): void {
    this.planUpdates.push({ ...input, entries: [...input.entries] });
  }
  onAvailableCommandsUpdate(input: AvailableCommandsUpdateCall): void {
    this.availableCommandsUpdates.push({ ...input, commands: [...input.commands] });
  }
  onModeChange(input: ModeChangeCall): void {
    this.modeChanges.push({ ...input });
  }
  onUsageUpdate(input: UsageUpdateCall): void {
    this.usageUpdates.push({ ...input });
  }
}

/**
 * Minimal SessionNotification builder for `agent_message_chunk` text deltas.
 */
function chunk(opts: { sessionId: string; messageId: string; text: string }): SessionNotification {
  return {
    sessionId: opts.sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: opts.messageId,
      content: { type: "text", text: opts.text },
    } as unknown as SessionNotification["update"],
  };
}

function thoughtChunk(opts: {
  sessionId: string;
  messageId: string;
  text: string;
}): SessionNotification {
  return {
    sessionId: opts.sessionId,
    update: {
      sessionUpdate: "agent_thought_chunk",
      messageId: opts.messageId,
      content: { type: "text", text: opts.text },
    } as unknown as SessionNotification["update"],
  };
}

describe("AcpStreamingTranslator", () => {
  describe("text streaming", () => {
    test("emits one onTextDelta per agent_message_chunk with delta + cumulative", () => {
      const t = new AcpStreamingTranslator();
      const sink = new RecordingAcpStreamingSink();
      const session = "s1";
      const msg = "m1";

      const deltas = ["H", "e", "l", "l", "o"];
      for (const d of deltas) {
        t.feed(chunk({ sessionId: session, messageId: msg, text: d }), sink);
      }

      expect(sink.textDeltas).toHaveLength(5);
      expect(sink.textDeltas.map((c) => c.delta)).toEqual(["H", "e", "l", "l", "o"]);
      expect(sink.textDeltas.map((c) => c.cumulativeText)).toEqual([
        "H",
        "He",
        "Hel",
        "Hell",
        "Hello",
      ]);
      // Every delta carries the same messageId.
      expect(new Set(sink.textDeltas.map((c) => c.messageId))).toEqual(new Set([msg]));
      // Nothing else fired.
      expect(sink.toolCallStarts).toHaveLength(0);
      expect(sink.toolCallUpdates).toHaveLength(0);
      expect(sink.thoughtDeltas).toHaveLength(0);
    });

    test("treats a different messageId as a new message — separate cumulative", () => {
      const t = new AcpStreamingTranslator();
      const sink = new RecordingAcpStreamingSink();

      t.feed(chunk({ sessionId: "s1", messageId: "m1", text: "Hi" }), sink);
      t.feed(chunk({ sessionId: "s1", messageId: "m2", text: "Yo" }), sink);
      t.feed(chunk({ sessionId: "s1", messageId: "m1", text: "!" }), sink);

      expect(sink.textDeltas).toEqual([
        { messageId: "m1", delta: "Hi", cumulativeText: "Hi" },
        { messageId: "m2", delta: "Yo", cumulativeText: "Yo" },
        { messageId: "m1", delta: "!", cumulativeText: "Hi!" },
      ]);
    });

    test("empty-text chunk is dropped (no sink call)", () => {
      const t = new AcpStreamingTranslator();
      const sink = new RecordingAcpStreamingSink();
      t.feed(chunk({ sessionId: "s1", messageId: "m1", text: "" }), sink);
      expect(sink.textDeltas).toHaveLength(0);
    });

    test("two parallel translators don't share state", () => {
      const t1 = new AcpStreamingTranslator();
      const t2 = new AcpStreamingTranslator();
      const s1 = new RecordingAcpStreamingSink();
      const s2 = new RecordingAcpStreamingSink();

      // Same messageId on both, different content.
      t1.feed(chunk({ sessionId: "s1", messageId: "shared", text: "AAA" }), s1);
      t2.feed(chunk({ sessionId: "s2", messageId: "shared", text: "BBB" }), s2);

      expect(s1.textDeltas[0]?.cumulativeText).toBe("AAA");
      expect(s2.textDeltas[0]?.cumulativeText).toBe("BBB");
    });
  });

  describe("thought streaming", () => {
    test("emits onThoughtDelta for agent_thought_chunk", () => {
      const t = new AcpStreamingTranslator();
      const sink = new RecordingAcpStreamingSink();
      t.feed(thoughtChunk({ sessionId: "s1", messageId: "t1", text: "thinking..." }), sink);
      expect(sink.thoughtDeltas).toEqual([
        { messageId: "t1", delta: "thinking...", cumulativeText: "thinking..." },
      ]);
      // Text-delta channel untouched.
      expect(sink.textDeltas).toHaveLength(0);
    });

    test("thought and text accumulate independently per messageId", () => {
      const t = new AcpStreamingTranslator();
      const sink = new RecordingAcpStreamingSink();
      // Same messageId for both kinds — translator should still keep them separate.
      t.feed(thoughtChunk({ sessionId: "s1", messageId: "x", text: "thought-1" }), sink);
      t.feed(chunk({ sessionId: "s1", messageId: "x", text: "spoken-1" }), sink);
      t.feed(thoughtChunk({ sessionId: "s1", messageId: "x", text: "thought-2" }), sink);

      expect(sink.thoughtDeltas.map((c) => c.cumulativeText)).toEqual([
        "thought-1",
        "thought-1thought-2",
      ]);
      expect(sink.textDeltas.map((c) => c.cumulativeText)).toEqual(["spoken-1"]);
    });
  });

  describe("tool calls", () => {
    test("emits onToolCallStart for tool_call notification", () => {
      const t = new AcpStreamingTranslator();
      const sink = new RecordingAcpStreamingSink();
      const notification: SessionNotification = {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc1",
          title: "Read",
          status: "pending",
        } as unknown as SessionNotification["update"],
      };
      t.feed(notification, sink);
      expect(sink.toolCallStarts).toEqual([
        { toolCallId: "tc1", title: "Read", status: "pending" },
      ]);
      expect(sink.toolCallUpdates).toHaveLength(0);
    });

    test("emits onToolCallUpdate for tool_call_update notification", () => {
      const t = new AcpStreamingTranslator();
      const sink = new RecordingAcpStreamingSink();
      const notification: SessionNotification = {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc1",
          status: "completed",
        } as unknown as SessionNotification["update"],
      };
      t.feed(notification, sink);
      expect(sink.toolCallUpdates).toEqual([
        { toolCallId: "tc1", status: "completed", content: undefined, rawLocations: undefined },
      ]);
    });
  });

  describe("non-streaming variants", () => {
    test("ignores config_option_update / session_info_update / user_message_chunk", () => {
      const t = new AcpStreamingTranslator();
      const sink = new RecordingAcpStreamingSink();
      const variants = [
        "config_option_update",
        "session_info_update",
        "user_message_chunk",
      ] as const;
      for (const sessionUpdate of variants) {
        t.feed(
          {
            sessionId: "s1",
            update: { sessionUpdate } as unknown as SessionNotification["update"],
          },
          sink,
        );
      }
      expect(sink.textDeltas).toHaveLength(0);
      expect(sink.thoughtDeltas).toHaveLength(0);
      expect(sink.toolCallStarts).toHaveLength(0);
      expect(sink.toolCallUpdates).toHaveLength(0);
      expect(sink.planUpdates).toHaveLength(0);
      expect(sink.availableCommandsUpdates).toHaveLength(0);
      expect(sink.modeChanges).toHaveLength(0);
      expect(sink.usageUpdates).toHaveLength(0);
    });
  });

  describe("plan updates", () => {
    test("emits onPlanUpdate with full entry list", () => {
      const t = new AcpStreamingTranslator();
      const sink = new RecordingAcpStreamingSink();
      t.feed(
        {
          sessionId: "s1",
          update: {
            sessionUpdate: "plan",
            entries: [
              { content: "step 1", status: "completed", priority: "high" },
              { content: "step 2", status: "in_progress", priority: "medium" },
              { content: "step 3", status: "pending", priority: "low" },
            ],
          } as unknown as SessionNotification["update"],
        },
        sink,
      );
      expect(sink.planUpdates).toHaveLength(1);
      expect(sink.planUpdates[0]?.entries).toEqual([
        { content: "step 1", status: "completed", priority: "high" },
        { content: "step 2", status: "in_progress", priority: "medium" },
        { content: "step 3", status: "pending", priority: "low" },
      ]);
    });

    test("forwards SDK-typed entries verbatim (no field-level filtering)", () => {
      // The translator delegates shape validation to the SDK schema:
      // it does NOT filter entries, mutate fields, or drop on missing
      // values. If a malformed update gets past the SDK boundary, that
      // surfaces in consumers, not silently drops here.
      const t = new AcpStreamingTranslator();
      const sink = new RecordingAcpStreamingSink();
      t.feed(
        {
          sessionId: "s1",
          update: {
            sessionUpdate: "plan",
            entries: [{ content: "ok", status: "pending", priority: "low" }],
          } as unknown as SessionNotification["update"],
        },
        sink,
      );
      expect(sink.planUpdates[0]?.entries).toHaveLength(1);
    });
  });

  describe("available commands updates", () => {
    test("emits onAvailableCommandsUpdate with full SDK-typed command set", () => {
      const t = new AcpStreamingTranslator();
      const sink = new RecordingAcpStreamingSink();
      t.feed(
        {
          sessionId: "s1",
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "/think", description: "toggle thinking" },
              { name: "/plan", description: "" },
            ],
          } as unknown as SessionNotification["update"],
        },
        sink,
      );
      expect(sink.availableCommandsUpdates).toHaveLength(1);
      expect(sink.availableCommandsUpdates[0]?.commands).toEqual([
        { name: "/think", description: "toggle thinking" },
        { name: "/plan", description: "" },
      ]);
    });
  });

  describe("mode changes", () => {
    test("emits onModeChange with currentModeId only (per ACP CurrentModeUpdate spec)", () => {
      const t = new AcpStreamingTranslator();
      const sink = new RecordingAcpStreamingSink();
      t.feed(
        {
          sessionId: "s1",
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: "execute",
          } as unknown as SessionNotification["update"],
        },
        sink,
      );
      expect(sink.modeChanges).toHaveLength(1);
      expect(sink.modeChanges[0]).toEqual({ currentModeId: "execute" });
    });

    test("drops update with missing currentModeId", () => {
      const t = new AcpStreamingTranslator();
      const sink = new RecordingAcpStreamingSink();
      t.feed(
        {
          sessionId: "s1",
          update: {
            sessionUpdate: "current_mode_update",
          } as unknown as SessionNotification["update"],
        },
        sink,
      );
      expect(sink.modeChanges).toHaveLength(0);
    });
  });

  describe("usage updates", () => {
    test("emits onUsageUpdate with SDK-typed structured Cost", () => {
      const t = new AcpStreamingTranslator();
      const sink = new RecordingAcpStreamingSink();
      const cost = { amount: 0.18, currency: "USD" };
      t.feed(
        {
          sessionId: "s1",
          update: {
            sessionUpdate: "usage_update",
            size: 200_000,
            used: 12_345,
            cost,
          } as unknown as SessionNotification["update"],
        },
        sink,
      );
      expect(sink.usageUpdates).toHaveLength(1);
      expect(sink.usageUpdates[0]).toEqual({ size: 200_000, used: 12_345, cost });
    });

    test("emits without cost when omitted", () => {
      const t = new AcpStreamingTranslator();
      const sink = new RecordingAcpStreamingSink();
      t.feed(
        {
          sessionId: "s1",
          update: {
            sessionUpdate: "usage_update",
            size: 100,
            used: 50,
          } as unknown as SessionNotification["update"],
        },
        sink,
      );
      expect(sink.usageUpdates[0]).toEqual({ size: 100, used: 50 });
    });

    test("preserves explicit null cost", () => {
      const t = new AcpStreamingTranslator();
      const sink = new RecordingAcpStreamingSink();
      t.feed(
        {
          sessionId: "s1",
          update: {
            sessionUpdate: "usage_update",
            size: 100,
            used: 50,
            cost: null,
          } as unknown as SessionNotification["update"],
        },
        sink,
      );
      expect(sink.usageUpdates[0]).toEqual({ size: 100, used: 50, cost: null });
    });
  });

  describe("delta semantics determinism", () => {
    test("same input sequence produces same sink-call sequence (idempotent translator behavior)", () => {
      const sink1 = new RecordingAcpStreamingSink();
      const sink2 = new RecordingAcpStreamingSink();
      const seq: SessionNotification[] = [
        chunk({ sessionId: "s", messageId: "m", text: "a" }),
        chunk({ sessionId: "s", messageId: "m", text: "b" }),
        thoughtChunk({ sessionId: "s", messageId: "m", text: "c" }),
        chunk({ sessionId: "s", messageId: "m", text: "d" }),
      ];

      const t1 = new AcpStreamingTranslator();
      const t2 = new AcpStreamingTranslator();
      for (const n of seq) {
        t1.feed(n, sink1);
        t2.feed(n, sink2);
      }

      expect(sink1.textDeltas).toEqual(sink2.textDeltas);
      expect(sink1.thoughtDeltas).toEqual(sink2.thoughtDeltas);
    });
  });
});
