import type { A2ASessionState } from "@agents-js/a2a-client";
import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";

export interface ClientHeader {
  root: BoxRenderable;
  update(state: A2ASessionState): void;
}

export function createClientHeader(renderer: CliRenderer): ClientHeader {
  const title = new TextRenderable(renderer, {
    id: "client-header-title",
    content: "agents-js client",
    fg: "#e0af68",
  });
  const status = new TextRenderable(renderer, {
    id: "client-header-status",
    content: "[idle]",
    fg: "#7aa2f7",
  });

  const root = new BoxRenderable(renderer, {
    id: "client-header-root",
    width: "100%",
    height: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingLeft: 1,
    paddingRight: 1,
  });

  root.add(title);
  root.add(status);

  return {
    root,
    update(state) {
      const targetLabel = state.target?.card.name ?? state.target?.baseUrl ?? "no target";
      title.content = `agents-js client — ${targetLabel}`;
      if (state.status === "error" && state.lastError) {
        const truncated =
          state.lastError.length > 60 ? `${state.lastError.slice(0, 57)}...` : state.lastError;
        status.content = `[error] ${truncated}`;
      } else {
        status.content = `[${state.status}]`;
      }
      status.fg =
        state.status === "error"
          ? "#f7768e"
          : state.status === "connected" || state.status === "completed"
            ? "#9ece6a"
            : "#7aa2f7";
    },
  };
}
