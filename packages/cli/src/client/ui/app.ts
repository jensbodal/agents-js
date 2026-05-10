import type { A2AClientController } from "@agents-js/a2a-client";
import { BoxRenderable, type CliRenderer } from "@opentui/core";
import { createClientActiveAction } from "./active-action.ts";
import { createClientHeader } from "./header.ts";
import { createClientInputBar } from "./input-bar.ts";
import { createClientInspector } from "./inspector.ts";
import { createClientTranscriptView } from "./transcript.ts";

export interface ClientApp {
  destroy(): void;
  nextInspectorTab(): void;
  start(): void;
}

export interface ClientAppOptions {
  poll: boolean;
  raw: boolean;
}

export function createClientApp(
  renderer: CliRenderer,
  controller: A2AClientController,
  options: ClientAppOptions,
): ClientApp {
  const header = createClientHeader(renderer);
  const transcript = createClientTranscriptView(renderer);
  const inspector = createClientInspector(renderer, options.raw);
  const activeAction = createClientActiveAction(renderer);
  const inputBar = createClientInputBar(renderer, {
    onAuthSelection: async (methodId) => {
      await controller.respondToAuthRequired(methodId);
    },
    onElicitationResponse: async (response) => {
      await controller.respondToElicitation(response);
    },
    onSend: async (message) => {
      await controller.sendTurn(message, {
        poll: options.poll,
      });
    },
    // Surface auth/elicitation/send failures into session state so the
    // header + inspector display them instead of silently swallowing.
    onError: (error) => {
      controller.reportError(error);
    },
  });

  const body = new BoxRenderable(renderer, {
    id: "client-body",
    width: "100%",
    flexGrow: 1,
    flexDirection: "row",
  });
  body.add(transcript.root);
  body.add(inspector.root);

  const root = new BoxRenderable(renderer, {
    id: "client-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: "#0f1117",
  });
  root.add(header.root);
  root.add(body);
  root.add(activeAction.root);
  root.add(inputBar.root);
  renderer.root.add(root);

  const unsubscribe = controller.subscribe((_event, state) => {
    header.update(state);
    transcript.update(state);
    inspector.update(state);
    activeAction.update(state);
    inputBar.update(state);
    // Flush a frame after every controller event. `@opentui/core`'s
    // `CliRenderer` runs a 30 FPS frame-loop; without an explicit flush,
    // 25+ synchronous `message.delta` events arrive in <1 ms and only the
    // final state lands in the painted frame, making streaming responses
    // appear as a single snap-in render. `intermediateRender()` is the
    // renderer's documented escape hatch for immediate-mode-style updates.
    renderer.intermediateRender();
  });

  return {
    destroy() {
      unsubscribe();
      activeAction.destroy();
    },
    nextInspectorTab() {
      inspector.nextTab();
      inspector.update(controller.getState());
    },
    start() {
      const state = controller.getState();
      header.update(state);
      transcript.update(state);
      inspector.update(state);
      activeAction.update(state);
      inputBar.update(state);
      inputBar.focus();
    },
  };
}
