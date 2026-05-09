import type {
  A2ASessionState,
  ACPA2AElicitation,
  ACPA2AElicitationContentValue,
  ACPA2AElicitationResponse,
} from "@agents-js/a2a-client";
import { type FieldMeta, toFieldMetas } from "@agents-js/schema-utils";
import {
  BoxRenderable,
  type CliRenderer,
  InputRenderable,
  InputRenderableEvents,
  TextRenderable,
} from "@opentui/core";

type ElicitationDraft = {
  fieldIndex: number;
  fields: FieldMeta[];
  id: string;
  values: Record<string, ACPA2AElicitationContentValue>;
};

export interface ClientInputBar {
  root: BoxRenderable;
  focus(): void;
  submit(message: string): Promise<void>;
  update(state: A2ASessionState): void;
}

export interface ClientInputBarOptions {
  onAuthSelection(methodId: string): Promise<void> | void;
  onElicitationResponse(response: ACPA2AElicitationResponse): Promise<void> | void;
  onSend(message: string): Promise<void> | void;
  /**
   * Optional hook invoked when an auth/elicitation/send callback throws.
   * App-level wiring routes the error into the controller so the header
   * + inspector can display it. When omitted, errors are still logged to
   * stderr so they are never fully swallowed.
   */
  onError?(error: unknown): void;
}

type ClientInputBarCallbacks = ClientInputBarOptions | ((message: string) => Promise<void> | void);

const DEFAULT_HINT = "Type a message and press Enter...";

function parseBoolean(input: string): boolean | undefined {
  const normalized = input.trim().toLowerCase();
  if (["true", "t", "yes", "y", "1"].includes(normalized)) {
    return true;
  }
  if (["false", "f", "no", "n", "0"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseFieldValue(
  field: FieldMeta,
  raw: string,
): { error?: string; value?: ACPA2AElicitationContentValue } {
  const trimmed = raw.trim();
  if (!trimmed) {
    if (field.required) {
      return { error: `${field.name} is required.` };
    }
    return {};
  }

  if (field.type === "boolean") {
    const value = parseBoolean(trimmed);
    return value === undefined
      ? { error: `Enter true/false, yes/no, or 1/0 for ${field.name}.` }
      : { value };
  }

  if (field.type === "integer") {
    const value = Number.parseInt(trimmed, 10);
    return Number.isNaN(value) ? { error: `Enter an integer for ${field.name}.` } : { value };
  }

  if (field.type === "number") {
    const value = Number.parseFloat(trimmed);
    return Number.isNaN(value) ? { error: `Enter a number for ${field.name}.` } : { value };
  }

  if (field.type === "array") {
    const values = trimmed
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (field.required && values.length === 0) {
      return { error: `${field.name} requires at least one value.` };
    }
    if (field.enumValues && values.some((value) => !field.enumValues?.includes(value))) {
      return {
        error: `${field.name} must use one of: ${field.enumValues.join(", ")}.`,
      };
    }
    return { value: values };
  }

  if (field.enumValues && !field.enumValues.includes(trimmed)) {
    return {
      error: `${field.name} must be one of: ${field.enumValues.join(", ")}.`,
    };
  }

  return { value: trimmed };
}

function buildDefaultLabel(state: A2ASessionState): string {
  if (state.status === "auth_required") {
    return state.activeAuth?.message ?? "Authentication required for the active task.";
  }

  if (state.status === "input_required") {
    return state.activeElicitation?.message ?? "Input required for the active task.";
  }

  return DEFAULT_HINT;
}

function buildFieldPrompt(elicitation: ACPA2AElicitation, field: FieldMeta): string {
  const label = field.title ?? field.name;
  const parts = [
    elicitation.message,
    `${label} (${field.type}${field.required ? ", required" : ""})`,
  ];
  if (field.description) {
    parts.push(field.description);
  }
  if (field.enumValues && field.enumValues.length > 0) {
    if (field.oneOfTitles) {
      const labeled = field.enumValues.map((v) =>
        field.oneOfTitles?.[v] ? `${v} (${field.oneOfTitles[v]})` : v,
      );
      parts.push(`Options: ${labeled.join(", ")}`);
    } else {
      parts.push(`Options: ${field.enumValues.join(", ")}`);
    }
  }
  if (field.multiSelect) {
    parts.push("Enter a comma-separated list.");
  }
  parts.push("Use /cancel to cancel or /decline to decline.");
  return parts.join("  ");
}

function getElicitationDraftId(elicitation: ACPA2AElicitation): string {
  return JSON.stringify({
    message: elicitation.message,
    requestedSchema: elicitation.requestedSchema,
    sessionId: elicitation.sessionId ?? null,
  });
}

export function createClientInputBar(
  renderer: CliRenderer,
  options: ClientInputBarCallbacks,
): ClientInputBar {
  const callbacks: ClientInputBarOptions =
    typeof options === "function"
      ? {
          onAuthSelection: async () => {},
          onElicitationResponse: async () => {},
          onSend: options,
        }
      : options;

  let currentState: A2ASessionState | undefined;
  let draft: ElicitationDraft | undefined;

  const hint = new TextRenderable(renderer, {
    id: "client-input-hint",
    content: "",
    fg: "#7aa2f7",
  });

  const input = new InputRenderable(renderer, {
    placeholder: DEFAULT_HINT,
    width: "100%",
    backgroundColor: "#1a1b26",
    focusedBackgroundColor: "#24283b",
    textColor: "#c0caf5",
    cursorColor: "#7aa2f7",
  });

  const root = new BoxRenderable(renderer, {
    id: "client-input-root",
    width: "100%",
    flexDirection: "column",
  });
  root.add(hint);
  root.add(input);

  function syncHint(): void {
    const state = currentState;
    if (!state?.activeElicitation) {
      const label = buildDefaultLabel(state ?? ({ status: "idle" } as A2ASessionState));
      if (label === DEFAULT_HINT) {
        input.placeholder = DEFAULT_HINT;
        hint.content = "";
      } else {
        input.placeholder = "";
        hint.content = label;
      }
      return;
    }

    input.placeholder = "";
    const currentField = draft?.fields[draft.fieldIndex];
    hint.content = currentField
      ? buildFieldPrompt(state.activeElicitation, currentField)
      : state.activeElicitation.message;
  }

  function syncDraft(state: A2ASessionState): void {
    currentState = state;
    const elicitation = state.activeElicitation;

    if (!elicitation) {
      draft = undefined;
      syncHint();
      return;
    }

    const draftId = getElicitationDraftId(elicitation);
    if (!draft || draft.id !== draftId) {
      draft = {
        fieldIndex: 0,
        fields: toFieldMetas(elicitation.requestedSchema),
        id: draftId,
        values: {},
      };
    }

    syncHint();
  }

  async function submit(message: string): Promise<void> {
    try {
      const state = currentState;
      const elicitation = state?.activeElicitation;
      const auth = state?.activeAuth;

      if (!elicitation || !draft) {
        if (auth) {
          const trimmed = message.trim();
          const methodId = trimmed.startsWith("/auth ") ? trimmed.slice(6).trim() : trimmed;
          if (!methodId) {
            hint.content = "Enter /auth <method-id> to continue.";
            return;
          }
          await callbacks.onAuthSelection(methodId);
          input.clear();
          return;
        }

        await callbacks.onSend(message);
        return;
      }

      const trimmed = message.trim();
      if (trimmed === "/cancel") {
        await callbacks.onElicitationResponse({ action: "cancel" });
        input.clear();
        return;
      }
      if (trimmed === "/decline") {
        await callbacks.onElicitationResponse({ action: "decline" });
        input.clear();
        return;
      }

      const field = draft.fields[draft.fieldIndex];
      if (!field) {
        await callbacks.onElicitationResponse({
          action: "accept",
          content: Object.keys(draft.values).length > 0 ? { ...draft.values } : undefined,
        });
        input.clear();
        return;
      }

      const parsed = parseFieldValue(field, trimmed);
      if (parsed.error) {
        hint.content = parsed.error;
        return;
      }

      if (parsed.value !== undefined) {
        draft.values[field.name] = parsed.value;
      }
      draft.fieldIndex += 1;

      const nextField = draft.fields[draft.fieldIndex];
      if (!nextField) {
        await callbacks.onElicitationResponse({
          action: "accept",
          content: Object.keys(draft.values).length > 0 ? { ...draft.values } : undefined,
        });
        input.clear();
      }

      syncHint();
    } catch (error) {
      // Surface the failure via the optional `onError` hook (app wiring
      // routes this into `controller.reportError` so the header +
      // inspector display it). Always log to stderr as well so a
      // misconfigured app without `onError` wiring still produces a
      // diagnostic rather than silently dropping the error.
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[agents-js client] submit callback failed: ${message}\n`);
      if (callbacks.onError) {
        callbacks.onError(error);
      }
    }
  }

  input.on(InputRenderableEvents.ENTER, (value: string) => {
    const trimmed = value.trim();
    if (trimmed || currentState?.activeElicitation) {
      void submit(value);
      input.clear();
      input.focus();
    }
  });

  input.focus();

  return {
    root,
    focus() {
      input.focus();
    },
    submit,
    update(state) {
      syncDraft(state);
    },
  };
}
