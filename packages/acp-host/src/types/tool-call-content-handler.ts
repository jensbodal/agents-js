import type { ToolCallContent } from "@agentclientprotocol/sdk";
import type { Logger } from "../logger.ts";
import type { ACPSessionEvent } from "./session.ts";

export interface ToolCallContentHandlerContext {
  emit(event: ACPSessionEvent): void;
  log: Logger;
}

export interface ToolCallContentHandler {
  /**
   * Return `true` when this handler has consumed the item and the host
   * should omit it from the regular rich-content rendering path.
   */
  consume(item: ToolCallContent, context: ToolCallContentHandlerContext): boolean;
  close?(): Promise<void> | void;
}
