import type { PromptRequest } from "@agentclientprotocol/sdk";

/**
 * Extract the concatenated textual representation of an ACP `PromptRequest`.
 *
 * Local-process agent adapters (pi-acp, droid-acp, trial-agent, ...) all need
 * to flatten the structured `prompt` array into a single string before handing
 * it off to a CLI / process / handler that consumes plain text. The mapping is:
 *
 * - `text` blocks contribute their `text`.
 * - `resource_link` blocks contribute `<uri>` placeholder text so the
 *   downstream agent at least sees the reference rather than silently dropping
 *   it. Adapters that want richer file-mention syntax (`@path`, etc.) should
 *   layer that on top of the placeholder rather than reinventing the
 *   extraction loop.
 * - All other block types (image, audio, embedded resource, ...) are dropped.
 *   Adapters with explicit support for those modalities should compose around
 *   this helper rather than within it.
 *
 * Blocks are joined without a separator — the caller is responsible for any
 * formatting (newlines between blocks, etc.) it needs.
 */
export function extractPromptText(request: PromptRequest): string {
  const parts: string[] = [];
  for (const block of request.prompt) {
    if (!block || typeof block !== "object" || !("type" in block)) continue;
    const typed = block as { type: string; text?: string; uri?: string };
    if (typed.type === "text" && typeof typed.text === "string") {
      parts.push(typed.text);
    } else if (typed.type === "resource_link" && typeof typed.uri === "string") {
      parts.push(`<${typed.uri}>`);
    }
  }
  return parts.join("");
}
