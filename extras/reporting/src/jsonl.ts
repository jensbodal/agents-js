export interface JsonlEvent {
  type: string;
  [key: string]: unknown;
}

export function parseJsonlEvents(raw: string): JsonlEvent[] {
  const events: JsonlEvent[] = [];
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as JsonlEvent;
      if (parsed && typeof parsed.type === "string") {
        events.push(parsed);
      }
    } catch {
      // Ignore non-JSONL lines. Codex exec can emit plain diagnostics.
    }
  }

  return events;
}

export function extractLastAgentMessage(events: JsonlEvent[]): string {
  let text: string | undefined;

  for (const event of events) {
    if (event.type !== "item.completed") {
      continue;
    }

    const item = event.item as Record<string, unknown> | undefined;
    if (!item || item.type !== "agent_message") {
      continue;
    }

    const maybeText = item.text;
    if (typeof maybeText === "string") {
      text = maybeText;
    }
  }

  if (!text) {
    throw new Error("No agent_message item found in codex JSONL output");
  }

  return text;
}
