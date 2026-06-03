/**
 * ACP custom catalog for A2UI.
 *
 * Registers agents-js-specific host components (ACP chat, transcript, permission modal, etc.)
 * as an A2UI custom catalog layered on top of `@a2ui/web_core`'s basic catalog.
 *
 * Catalog id: `https://agents-js.bodal.dev/catalog/acp/0.1`.
 *
 * Each entry follows the `ComponentApi` shape from `@a2ui/web_core`:
 * - `name`: the component identifier as it appears in A2UI `updateComponents` messages.
 * - `schema`: a strict zod object describing the component's properties.
 *
 * Shared property shapes (`DynamicString`, `ChildList`, `Action`, etc.) are imported from
 * `@a2ui/web_core` so ACP components stay wire-compatible with the rest of A2UI.
 */

import {
  AccessibilityAttributesSchema,
  ActionSchema,
  Catalog,
  ChildListSchema,
  DynamicBooleanSchema,
  DynamicStringListSchema,
  DynamicStringSchema,
} from "@a2ui/web_core/v0_9";
import { z } from "zod";
import type { ComponentApi } from "./component-api.ts";

/** Stable identifier for the ACP custom catalog. */
export const ACP_CATALOG_ID = "https://agents-js.bodal.dev/catalog/acp/0.1";

/**
 * Properties shared by every component in the ACP catalog — mirrors the pattern used by
 * `@a2ui/web_core`'s basic catalog.
 */
const AcpCommonProps = {
  accessibility: AccessibilityAttributesSchema.optional(),
  weight: z
    .number()
    .describe(
      "Relative weight in a Row/Column. Mirrors the basic-catalog semantic. May only be set when this component is a direct child of a Row or Column.",
    )
    .optional(),
};

/** Top-level chat surface: wraps transcript + prompt input + status bar. */
export const ChatAppApi = {
  name: "AcpChatApp",
  schema: z
    .object({
      ...AcpCommonProps,
      transcript: z.string().describe("Component id reference to the transcript child."),
      promptInput: z.string().describe("Component id reference to the prompt input child."),
      statusBar: z.string().describe("Component id reference to the status bar child.").optional(),
      title: DynamicStringSchema.describe(
        "Optional header title. Supports data binding.",
      ).optional(),
    })
    .strict(),
} as const satisfies ComponentApi;

/** Scrollable message list for an ACP session. */
export const TranscriptApi = {
  name: "AcpTranscript",
  schema: z
    .object({
      ...AcpCommonProps,
      children: ChildListSchema.describe(
        "Ordered list of child component ids (AcpMessage / StreamingText / etc.).",
      ),
      autoScroll: (
        DynamicBooleanSchema.describe(
          "Whether the transcript should auto-scroll on new messages.",
        ) as unknown as z.ZodBoolean
      )
        .optional()
        .default(true),
    })
    .strict(),
} as const satisfies ComponentApi;

/** A single chat message (user / agent / system). */
export const MessageApi = {
  name: "AcpMessage",
  schema: z
    .object({
      ...AcpCommonProps,
      role: z.enum(["user", "agent", "system", "tool"]).describe("Speaker role for this message."),
      author: DynamicStringSchema.describe("Display name or agent identifier.").optional(),
      body: DynamicStringSchema.describe(
        "Message body. Supports markdown (without HTML/images) and data binding.",
      ),
      timestamp: DynamicStringSchema.describe("ISO-8601 timestamp for this message.").optional(),
    })
    .strict(),
} as const satisfies ComponentApi;

/** Token-stream text surface (partial updates). */
export const StreamingTextApi = {
  name: "AcpStreamingText",
  schema: z
    .object({
      ...AcpCommonProps,
      text: DynamicStringSchema.describe(
        "Current text content. Host may replace rapidly; renderer should buffer.",
      ),
      done: DynamicBooleanSchema.describe("Whether the stream is complete.").optional(),
    })
    .strict(),
} as const satisfies ComponentApi;

/** Multi-line prompt input with submit action. */
export const PromptInputApi = {
  name: "AcpPromptInput",
  schema: z
    .object({
      ...AcpCommonProps,
      value: z
        .object({ path: z.string() })
        .describe(
          "JSON Pointer binding for the input value. Two-way — renderer writes keystrokes here.",
        ),
      placeholder: DynamicStringSchema.describe("Placeholder text when empty.").optional(),
      submit: ActionSchema.describe("Action dispatched when the user submits.").optional(),
      disabled: DynamicBooleanSchema.describe("Whether input should reject new text.").optional(),
    })
    .strict(),
} as const satisfies ComponentApi;

/** Connection dialog for choosing an A2A endpoint/runtime. */
export const ConnectDialogApi = {
  name: "AcpConnectDialog",
  schema: z
    .object({
      ...AcpCommonProps,
      title: DynamicStringSchema.describe("Dialog title.").optional(),
      runtimes: DynamicStringListSchema.describe("Available runtime identifiers."),
      selected: z
        .object({ path: z.string() })
        .describe("JSON Pointer binding for the selected runtime.")
        .optional(),
      confirm: ActionSchema.describe("Action for confirm/connect.").optional(),
      cancel: ActionSchema.describe("Action for cancel/dismiss.").optional(),
    })
    .strict(),
} as const satisfies ComponentApi;

/** Structured elicitation form — a sequence of labelled fields with a submit action. */
export const ElicitationFormApi = {
  name: "AcpElicitationForm",
  schema: z
    .object({
      ...AcpCommonProps,
      children: ChildListSchema.describe(
        "Ordered list of field component ids (TextField / CheckBox / ChoicePicker / Slider / DateTimeInput).",
      ),
      submit: ActionSchema.describe("Action dispatched on submit."),
      cancel: ActionSchema.describe("Action dispatched on cancel.").optional(),
      title: DynamicStringSchema.describe("Form title.").optional(),
      description: DynamicStringSchema.describe("Explanatory text above the fields.").optional(),
    })
    .strict(),
} as const satisfies ComponentApi;

/** Modal asking the user to approve or deny a sensitive operation. */
export const PermissionModalApi = {
  name: "AcpPermissionModal",
  schema: z
    .object({
      ...AcpCommonProps,
      operation: DynamicStringSchema.describe(
        "Human-readable description of the requested operation.",
      ),
      target: DynamicStringSchema.describe(
        "Target of the operation (file path, tool name, etc.).",
      ).optional(),
      approve: ActionSchema.describe("Action dispatched on approval."),
      deny: ActionSchema.describe("Action dispatched on denial."),
      remember: DynamicBooleanSchema.describe(
        "Whether the user's choice should be remembered for this session.",
      ).optional(),
    })
    .strict(),
} as const satisfies ComponentApi;

/** Selector for the active permission mode (ask / acceptEdits / bypass / plan). */
export const PermissionModeSelectorApi = {
  name: "AcpPermissionModeSelector",
  schema: z
    .object({
      ...AcpCommonProps,
      value: z.object({ path: z.string() }).describe("JSON Pointer binding for the active mode."),
      modes: DynamicStringListSchema.describe("Available mode identifiers.").optional(),
      change: ActionSchema.describe("Action dispatched when the mode changes.").optional(),
    })
    .strict(),
} as const satisfies ComponentApi;

/** Modal shown when a write operation hits the write-gate policy. */
export const WriteGateModalApi = {
  name: "AcpWriteGateModal",
  schema: z
    .object({
      ...AcpCommonProps,
      path: DynamicStringSchema.describe("File path subject to the gate."),
      rationale: DynamicStringSchema.describe("Rationale for gating the write.").optional(),
      allow: ActionSchema.describe("Action dispatched on allow."),
      block: ActionSchema.describe("Action dispatched on block."),
    })
    .strict(),
} as const satisfies ComponentApi;

/** Selector for an authentication method or session. */
export const AuthSelectorApi = {
  name: "AcpAuthSelector",
  schema: z
    .object({
      ...AcpCommonProps,
      methods: DynamicStringListSchema.describe("Available auth method identifiers."),
      selected: z
        .object({ path: z.string() })
        .describe("JSON Pointer binding for the chosen method.")
        .optional(),
      confirm: ActionSchema.describe("Action dispatched when the user confirms.").optional(),
    })
    .strict(),
} as const satisfies ComponentApi;

/** Debug panel (log transports, span inspector). Host-only diagnostic surface. */
export const DebugPanelApi = {
  name: "AcpDebugPanel",
  schema: z
    .object({
      ...AcpCommonProps,
      logs: z.object({ path: z.string() }).describe("JSON Pointer binding for the log stream."),
      enabled: DynamicBooleanSchema.describe("Whether the panel is expanded.").optional(),
    })
    .strict(),
} as const satisfies ComponentApi;

/** Persistent status bar at the bottom of a chat surface. */
export const StatusBarApi = {
  name: "AcpStatusBar",
  schema: z
    .object({
      ...AcpCommonProps,
      status: DynamicStringSchema.describe(
        "Current status text (e.g. 'connected', 'thinking', 'error').",
      ),
      detail: DynamicStringSchema.describe("Optional secondary detail string.").optional(),
    })
    .strict(),
} as const satisfies ComponentApi;

/** Fenced-code block with optional language hint. */
export const CodeBlockApi = {
  name: "AcpCodeBlock",
  schema: z
    .object({
      ...AcpCommonProps,
      code: DynamicStringSchema.describe("Source text to display."),
      language: DynamicStringSchema.describe(
        "Optional language identifier for syntax highlighting.",
      ).optional(),
      filename: DynamicStringSchema.describe("Optional filename shown as a header.").optional(),
    })
    .strict(),
} as const satisfies ComponentApi;

/**
 * Ordered list of all ACP component APIs. Consumers can iterate this to register
 * renderers for every ACP component.
 */
export const ACP_COMPONENT_APIS = [
  ChatAppApi,
  TranscriptApi,
  MessageApi,
  StreamingTextApi,
  PromptInputApi,
  ConnectDialogApi,
  ElicitationFormApi,
  PermissionModalApi,
  PermissionModeSelectorApi,
  WriteGateModalApi,
  AuthSelectorApi,
  DebugPanelApi,
  StatusBarApi,
  CodeBlockApi,
] as const satisfies readonly ComponentApi[];

/**
 * ACP custom catalog instance. Pass alongside the basic catalog to a `MessageProcessor`:
 *
 * ```ts
 * import { BasicCatalog } from "@a2ui/web_core/v0_9/basic_catalog";
 * import { MessageProcessor } from "@a2ui/web_core/v0_9";
 * import { AcpCatalog } from "@agents-js/a2ui-types";
 *
 * const processor = new MessageProcessor([BasicCatalog, AcpCatalog]);
 * ```
 */
// Upstream `Catalog` constructor still expects `ComponentApi<z.ZodTypeAny>` (zod v3 constraint);
// our local ComponentApi shadow widens the schema to `z.ZodType` for v4 compat. Cast
// through at this single boundary — remove when @a2ui/web_core is upgraded for zod v4.
export const AcpCatalog = new Catalog(
  ACP_CATALOG_ID,
  Array.from(ACP_COMPONENT_APIS) as unknown as ConstructorParameters<typeof Catalog>[1],
);
