import type { ToolCallContent } from "@agentclientprotocol/sdk";
import { A2UI_META_KEY, type A2uiMessage } from "@agents-js/a2ui-types";
import type { Logger, ToolCallContentHandler } from "@agents-js/acp-host";
import { validateA2uiMessage } from "@agents-js/validation/a2ui";
import type { HostSurfaceAdapter } from "./host-surface-adapter.ts";
import { SurfaceSession } from "./surface-session.ts";

export interface CreateA2uiToolCallContentHandlerOptions {
  surfaceAdapter?: HostSurfaceAdapter | null;
}

function extractA2uiMessage(item: ToolCallContent): unknown {
  if (item.type !== "content") return undefined;
  const meta = (item as { _meta?: Record<string, unknown> | null })._meta;
  if (!meta || typeof meta !== "object") return undefined;
  return meta[A2UI_META_KEY];
}

function createNoopSurfaceAdapter(): HostSurfaceAdapter {
  return {
    handleSurfaceMessage() {},
    handleSurfaceClosed() {},
  };
}

export function createA2uiToolCallContentHandler(
  options: CreateA2uiToolCallContentHandlerOptions = {},
): ToolCallContentHandler {
  const adapter = options.surfaceAdapter ?? createNoopSurfaceAdapter();
  let surfaceSession: SurfaceSession | null = null;
  let applyChain = Promise.resolve();

  const getOrCreateSurfaceSession = (
    log: Logger,
    emitSurfaceEvent: (surfaceId: string, event: unknown) => void,
  ) => {
    if (!surfaceSession) {
      surfaceSession = new SurfaceSession({
        adapter,
        log,
        emitSurfaceEvent,
      });
    }
    return surfaceSession;
  };

  return {
    consume(item, context) {
      const raw = extractA2uiMessage(item);
      if (raw === undefined) {
        return false;
      }

      const result = validateA2uiMessage(raw);
      if (!result.valid) {
        context.log.warn("Invalid A2UI message in tool_call content; dropping", {
          error: result.error.message,
        });
        return true;
      }

      const session = getOrCreateSurfaceSession(context.log, (surfaceId, event) => {
        context.emit({ type: "surface_event", surfaceId, event });
      });

      applyChain = applyChain
        .then(() => session.apply(result.value satisfies A2uiMessage))
        .catch((error) => {
          context.log.error("SurfaceSession.apply failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });

      return true;
    },
    async close() {
      await applyChain;
      await surfaceSession?.close();
      surfaceSession = null;
    },
  };
}
