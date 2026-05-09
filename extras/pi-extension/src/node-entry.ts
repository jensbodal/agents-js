/**
 * Node.js-compatible entry point for the Pi extension.
 *
 * Always uses DirectClient (in-process A2A) — the McpBridgeClient
 * requires Bun.spawn and cannot run on Node.js.
 */
import { Type } from "@sinclair/typebox";
import { DirectClient } from "./direct-client.ts";
import {
  type AgentBridge,
  type AgentTool,
  adaptPiOnUpdate,
  type PiContextEvent,
  type PiHost,
  type PiOnUpdate,
} from "./types.ts";

export default function agentsJsBridge(pi: PiHost): void {
  let bridge: AgentBridge | null = null;
  let discoveredTools: AgentTool[] = [];

  pi.on("session_start", async (_event: unknown, _ctx: unknown) => {
    try {
      bridge = new DirectClient();
      await bridge.initialize();
      discoveredTools = await bridge.listTools();

      for (const tool of discoveredTools) {
        pi.registerTool({
          name: `a2a_${tool.name}`,
          label: `Agent: ${tool.name}`,
          description: tool.description,
          parameters: Type.Object({
            message: Type.String({ description: "Message to send to the agent" }),
          }),
          async execute(
            _toolCallId: string,
            params: { message: string },
            _signal: AbortSignal,
            onUpdate: PiOnUpdate | undefined,
            _ctx: unknown,
          ) {
            if (!bridge) {
              return { content: [{ type: "text", text: "Bridge not available" }] };
            }
            if (onUpdate) {
              onUpdate({ type: "progress", text: `Dispatching to ${tool.name}...` });
            }
            const response = await bridge.callTool(
              tool.name,
              params.message,
              adaptPiOnUpdate(onUpdate),
            );
            return { content: [{ type: "text", text: response }] };
          },
        });
      }
    } catch (error) {
      console.error(
        "[agents-js-bridge] Failed to initialize:",
        error instanceof Error ? error.message : error,
      );
    }
  });

  pi.on("context", (event: unknown, _ctx: unknown) => {
    if (discoveredTools.length === 0) {
      return;
    }

    const lines = discoveredTools.map((t) => `- a2a_${t.name}: ${t.description}`);
    const systemMessage = {
      role: "system",
      content: `Available A2A agents (use the corresponding tool to communicate):\n${lines.join("\n")}`,
    };

    const ctxEvent = event as PiContextEvent;
    if (Array.isArray(ctxEvent.messages)) {
      ctxEvent.messages.unshift(systemMessage);
    }
  });

  pi.on("session_shutdown", async (_event: unknown, _ctx: unknown) => {
    if (bridge) {
      await bridge.destroy();
      bridge = null;
    }
    discoveredTools = [];
  });
}
