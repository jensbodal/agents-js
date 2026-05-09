import type { A2ASessionState } from "@agents-js/a2a-client";
import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";

type InspectorTab = "card" | "session" | "debug";

export interface ClientInspector {
  root: BoxRenderable;
  nextTab(): void;
  update(state: A2ASessionState): void;
}

function formatCard(state: A2ASessionState, raw: boolean): string {
  if (!state.target) {
    return "No connected target";
  }

  if (raw) {
    return JSON.stringify(state.target.card, null, 2);
  }

  return [
    `name: ${state.target.card.name}`,
    `url: ${state.target.baseUrl}`,
    `protocol: ${state.target.protocolVersion ?? "unknown"}`,
    `input modes: ${state.target.capabilities.inputModes.join(", ") || "none"}`,
    `output modes: ${state.target.capabilities.outputModes.join(", ") || "none"}`,
    `streaming: ${state.target.capabilities.supportsStreaming ? "yes" : "no"}`,
  ].join("\n");
}

function formatSession(state: A2ASessionState): string {
  return [
    `session: ${state.sessionId}`,
    `status: ${state.status}`,
    `task state: ${state.taskState ?? "-"}`,
    `context: ${state.contextId ?? "-"}`,
    `task: ${state.taskId ?? "-"}`,
    `resumable: ${state.resumableTaskId ? "yes" : "no"}`,
    `messages: ${state.transcript.length}`,
    `pending: ${state.pendingAgentText ? "yes" : "no"}`,
    state.activeElicitation
      ? `elicitation: ${state.activeElicitation.requestedSchema.title ?? state.activeElicitation.message}`
      : "",
    state.activeAuth?.message ? `auth: ${state.activeAuth.message}` : "",
    state.lastError ? `error: ${state.lastError}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatDebug(state: A2ASessionState, raw: boolean): string {
  if (state.debugRecords.length === 0) {
    return "No debug records yet";
  }

  const records = state.debugRecords.slice(-8);
  if (raw) {
    return JSON.stringify(records, null, 2);
  }

  return records
    .map((record) => {
      if (record.kind === "client") {
        return `${record.method.padEnd(8, " ")} ${record.body ?? record.url}`;
      }
      const status = record.status ? ` ${record.status}` : "";
      return `${record.direction.padEnd(8, " ")} ${record.method}${status} ${record.url}`;
    })
    .join("\n");
}

export function createClientInspector(renderer: CliRenderer, raw: boolean): ClientInspector {
  let currentTab: InspectorTab = "card";

  const title = new TextRenderable(renderer, {
    id: "client-inspector-title",
    content: "Inspector: card",
    fg: "#bb9af7",
  });
  const content = new TextRenderable(renderer, {
    id: "client-inspector-content",
    content: "No connected target",
    fg: "#c0caf5",
  });

  const root = new BoxRenderable(renderer, {
    id: "client-inspector-root",
    width: 40,
    height: "100%",
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
    border: true,
    borderColor: "#414868",
  });

  root.add(title);
  root.add(content);

  return {
    root,
    nextTab() {
      currentTab = currentTab === "card" ? "session" : currentTab === "session" ? "debug" : "card";
    },
    update(state) {
      title.content = `Inspector: ${currentTab}`;
      content.content =
        currentTab === "card"
          ? formatCard(state, raw)
          : currentTab === "session"
            ? formatSession(state)
            : formatDebug(state, raw);
    },
  };
}
