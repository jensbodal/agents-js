import type { A2ASessionState, TranscriptEntry } from "@agents-js/a2a-client";
import {
  BoxRenderable,
  type CliRenderer,
  ScrollBoxRenderable,
  TextRenderable,
} from "@opentui/core";

export interface ClientTranscriptView {
  root: ScrollBoxRenderable;
  update(state: A2ASessionState): void;
}

function roleColor(role: TranscriptEntry["role"]): string {
  return role === "user" ? "#c0caf5" : "#9ece6a";
}

function renderEntry(renderer: CliRenderer, entry: TranscriptEntry, index: number): BoxRenderable {
  const box = new BoxRenderable(renderer, {
    id: `client-transcript-entry-${index}`,
    width: "100%",
    paddingTop: 0,
    paddingBottom: 0,
  });
  box.add(
    new TextRenderable(renderer, {
      id: `client-transcript-entry-text-${index}`,
      content: `  ${entry.role}: ${entry.text}`,
      fg: roleColor(entry.role),
    }),
  );
  return box;
}

export function createClientTranscriptView(renderer: CliRenderer): ClientTranscriptView {
  const root = new ScrollBoxRenderable(renderer, {
    id: "client-transcript-root",
    flexGrow: 1,
    width: "100%",
    stickyScroll: true,
    stickyStart: "bottom",
    viewportCulling: true,
  });

  const placeholder = new TextRenderable(renderer, {
    id: "client-transcript-placeholder",
    content: "  Waiting for messages...",
    fg: "#565f89",
  });
  root.add(placeholder);

  return {
    root,
    update(state) {
      for (const child of root.getChildren()) {
        root.remove(child.id);
      }

      if (
        state.transcript.length === 0 &&
        !state.pendingAgentText &&
        !state.activeElicitation &&
        !state.activeAuth?.message
      ) {
        root.add(placeholder);
        return;
      }

      state.transcript.forEach((entry, index) => {
        root.add(renderEntry(renderer, entry, index));
      });

      if (state.pendingAgentText) {
        root.add(
          renderEntry(
            renderer,
            {
              id: crypto.randomUUID(),
              role: "agent",
              text: state.pendingAgentText,
            },
            state.transcript.length,
          ),
        );
      }

      if (state.activeElicitation) {
        root.add(
          renderEntry(
            renderer,
            {
              id: crypto.randomUUID(),
              role: "agent",
              text: `[input required] ${state.activeElicitation.message}`,
            },
            state.transcript.length + 1,
          ),
        );
      } else if (state.activeAuth?.message) {
        root.add(
          renderEntry(
            renderer,
            {
              id: crypto.randomUUID(),
              role: "agent",
              text: `[auth required] ${state.activeAuth.message}`,
            },
            state.transcript.length + 1,
          ),
        );
      }
    },
  };
}
