/**
 * ACP catalog bindings for the A2UI renderer.
 *
 * One binding function per ACP component (15 total). Each function takes:
 *   - the raw A2UI component props (as authored in an `updateComponents`
 *     message),
 *   - a `BindingContext` carrying the surface id, an event dispatcher, and
 *     helpers for resolving child components and unwrapping dynamic values,
 *
 * and returns a Lit `TemplateResult` rendered against one of the 35 `acp-*`
 * primitives exported from `@agents-js/ui-components`.
 *
 * Side-effect imports below register the custom elements.
 */

import "@agents-js/ui-components";

import { html, nothing, type TemplateResult } from "lit";

/** An A2UI `Action` — either an action name string or a `{ action: string }` object. */
export type A2uiAction = string | { action: string; [key: string]: unknown };

/** An A2UI `DynamicString` / `DynamicBoolean` — a literal or a `{ path }` binding. */
export type DynamicValue<T> = T | { path: string } | { value: T };

/** Handler fired whenever an ACP primitive emits an event that should be forwarded. */
export type A2uiEventHandler = (
  surfaceId: string,
  actionName: string,
  payload: Record<string, unknown>,
) => void;

/** Context passed to every binding function. */
export interface BindingContext {
  /** The surface id currently being rendered. */
  readonly surfaceId: string;
  /** Host-supplied callback invoked when a wrapped Action fires. */
  readonly onEvent: A2uiEventHandler;
  /**
   * Resolve a child component id to a rendered `TemplateResult`. Supplied by
   * the surface view; unknown ids should return `nothing` so templates stay
   * well-formed.
   */
  readonly resolveChild: (id: string) => TemplateResult | typeof nothing;
}

/** Type-shape returned by the binding functions. */
export type BindingResult = TemplateResult;

/** Common shape that every ACP component envelope satisfies. */
interface AnyAcpProps {
  readonly weight?: number;
  readonly accessibility?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Best-effort unwrap of an A2UI dynamic value. The renderer is intentionally
 * pure (no data-model wiring); binding paths render as empty so
 * the host can drive them through Lit properties later.
 */
function unwrapString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const v = value as { path?: string; value?: unknown };
    if (typeof v.value === "string") return v.value;
    if (typeof v.value === "number" || typeof v.value === "boolean") return String(v.value);
    // Binding paths render as empty; host wires them in via Lit properties later.
    if (typeof v.path === "string") return "";
  }
  return "";
}

function unwrapBoolean(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "object") {
    const v = value as { value?: unknown };
    if (typeof v.value === "boolean") return v.value;
  }
  return fallback;
}

function unwrapStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => unwrapString(v));
  if (value && typeof value === "object") {
    const v = value as { value?: unknown };
    if (Array.isArray(v.value)) return v.value.map((x) => unwrapString(x));
  }
  return [];
}

function extractActionName(action: unknown): string {
  if (typeof action === "string") return action;
  if (action && typeof action === "object") {
    const a = action as { action?: unknown };
    if (typeof a.action === "string") return a.action;
  }
  return "";
}

/**
 * Wrap an A2UI `Action` into a DOM-event listener that forwards via
 * `ctx.onEvent(surfaceId, actionName, payload)`.
 */
function wrapAction(action: unknown, ctx: BindingContext) {
  const actionName = extractActionName(action);
  if (!actionName) {
    // No action bound — swallow the event so the primitive still works.
    return () => {};
  }
  return (evt: Event) => {
    const detail =
      evt instanceof CustomEvent && evt.detail && typeof evt.detail === "object"
        ? (evt.detail as Record<string, unknown>)
        : {};
    ctx.onEvent(ctx.surfaceId, actionName, detail);
  };
}

/** Resolve an ordered list of child ids into rendered template fragments. */
function renderChildren(ids: unknown, ctx: BindingContext): TemplateResult[] {
  if (!Array.isArray(ids)) return [];
  const out: TemplateResult[] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const fragment = ctx.resolveChild(id);
    if (fragment !== nothing) {
      out.push(fragment as TemplateResult);
    }
  }
  return out;
}

// -- 15 ACP bindings -------------------------------------------------------

export function bindChatApp(props: AnyAcpProps, ctx: BindingContext): BindingResult {
  const title = unwrapString(props.title);
  const transcriptId = typeof props.transcript === "string" ? props.transcript : "";
  const promptInputId = typeof props.promptInput === "string" ? props.promptInput : "";
  const statusBarId = typeof props.statusBar === "string" ? props.statusBar : "";
  const transcript = transcriptId ? ctx.resolveChild(transcriptId) : nothing;
  const promptInput = promptInputId ? ctx.resolveChild(promptInputId) : nothing;
  const statusBar = statusBarId ? ctx.resolveChild(statusBarId) : nothing;
  return html`<acp-chat-app .title=${title}>${statusBar}${transcript}${promptInput}</acp-chat-app>`;
}

export function bindTranscript(props: AnyAcpProps, ctx: BindingContext): BindingResult {
  const autoScroll = unwrapBoolean(props.autoScroll, true);
  const children = renderChildren(props.children, ctx);
  return html`<acp-transcript ?autoScroll=${autoScroll}>${children}</acp-transcript>`;
}

export function bindMessage(props: AnyAcpProps, _ctx: BindingContext): BindingResult {
  const role = typeof props.role === "string" ? props.role : "user";
  const body = unwrapString(props.body);
  const author = unwrapString(props.author);
  const timestamp = unwrapString(props.timestamp);
  return html`<acp-message
    role=${role}
    .text=${body}
    .author=${author}
    .timestamp=${timestamp}
  ></acp-message>`;
}

export function bindStreamingText(props: AnyAcpProps, _ctx: BindingContext): BindingResult {
  const text = unwrapString(props.text);
  const done = unwrapBoolean(props.done, false);
  return html`<acp-streaming-text .text=${text} ?done=${done}></acp-streaming-text>`;
}

export function bindPromptInput(props: AnyAcpProps, ctx: BindingContext): BindingResult {
  const placeholder = unwrapString(props.placeholder);
  const disabled = unwrapBoolean(props.disabled, false);
  const onSubmit = wrapAction(props.submit, ctx);
  return html`<acp-prompt-input
    .placeholder=${placeholder}
    ?disabled=${disabled}
    @acp-send=${onSubmit}
  ></acp-prompt-input>`;
}

export function bindConnectDialog(props: AnyAcpProps, ctx: BindingContext): BindingResult {
  const title = unwrapString(props.title);
  const runtimes = unwrapStringList(props.runtimes);
  const onConfirm = wrapAction(props.confirm, ctx);
  const onCancel = wrapAction(props.cancel, ctx);
  return html`<acp-connect-dialog
    .title=${title}
    .runtimes=${runtimes}
    @acp-connect=${onConfirm}
    @acp-cancel=${onCancel}
  ></acp-connect-dialog>`;
}

export function bindElicitationForm(props: AnyAcpProps, ctx: BindingContext): BindingResult {
  const title = unwrapString(props.title);
  const description = unwrapString(props.description);
  const onSubmit = wrapAction(props.submit, ctx);
  const onCancel = wrapAction(props.cancel, ctx);
  const children = renderChildren(props.children, ctx);
  return html`<acp-elicitation-form
    .title=${title}
    .description=${description}
    @acp-elicitation-response=${onSubmit}
    @acp-elicitation-cancel=${onCancel}
  >${children}</acp-elicitation-form>`;
}

export function bindPermissionModal(props: AnyAcpProps, ctx: BindingContext): BindingResult {
  const operation = unwrapString(props.operation);
  const target = unwrapString(props.target);
  const remember = unwrapBoolean(props.remember, false);
  const onApprove = wrapAction(props.approve, ctx);
  const onDeny = wrapAction(props.deny, ctx);
  return html`<acp-permission-modal
    .operation=${operation}
    .target=${target}
    ?remember=${remember}
    @acp-permission-approve=${onApprove}
    @acp-permission-deny=${onDeny}
  ></acp-permission-modal>`;
}

export function bindPermissionModeSelector(props: AnyAcpProps, ctx: BindingContext): BindingResult {
  const modes = unwrapStringList(props.modes);
  const onChange = wrapAction(props.change, ctx);
  return html`<acp-permission-mode-selector
    .modes=${modes}
    @acp-permission-mode-change=${onChange}
  ></acp-permission-mode-selector>`;
}

export function bindWriteGateModal(props: AnyAcpProps, ctx: BindingContext): BindingResult {
  const path = unwrapString(props.path);
  const rationale = unwrapString(props.rationale);
  const onAllow = wrapAction(props.allow, ctx);
  const onBlock = wrapAction(props.block, ctx);
  return html`<acp-write-gate-modal
    .path=${path}
    .rationale=${rationale}
    @acp-write-gate-allow=${onAllow}
    @acp-write-gate-block=${onBlock}
  ></acp-write-gate-modal>`;
}

export function bindAuthSelector(props: AnyAcpProps, ctx: BindingContext): BindingResult {
  const methods = unwrapStringList(props.methods);
  const onConfirm = wrapAction(props.confirm, ctx);
  return html`<acp-auth-selector
    .methods=${methods}
    @acp-auth-selected=${onConfirm}
  ></acp-auth-selector>`;
}

export function bindModelSelector(props: AnyAcpProps, ctx: BindingContext): BindingResult {
  const models = unwrapStringList(props.models);
  const onChange = wrapAction(props.change, ctx);
  return html`<acp-model-selector
    .models=${models}
    @acp-model-change=${onChange}
  ></acp-model-selector>`;
}

export function bindDebugPanel(props: AnyAcpProps, _ctx: BindingContext): BindingResult {
  const enabled = unwrapBoolean(props.enabled, false);
  return html`<acp-debug-panel ?enabled=${enabled}></acp-debug-panel>`;
}

export function bindStatusBar(props: AnyAcpProps, _ctx: BindingContext): BindingResult {
  const status = unwrapString(props.status);
  const detail = unwrapString(props.detail);
  return html`<acp-status-bar .status=${status} .detail=${detail}></acp-status-bar>`;
}

export function bindCodeBlock(props: AnyAcpProps, _ctx: BindingContext): BindingResult {
  const code = unwrapString(props.code);
  const language = unwrapString(props.language);
  const filename = unwrapString(props.filename);
  return html`<acp-code-block
    .code=${code}
    .language=${language}
    .filename=${filename}
  ></acp-code-block>`;
}

/**
 * Map from A2UI ACP component name (per `ComponentApi.name`) to binding
 * function. Populated once at module load — matches the frozen 15-component
 * ACP catalog.
 */
export const ACP_BINDINGS: Readonly<
  Record<string, (props: AnyAcpProps, ctx: BindingContext) => BindingResult>
> = {
  AcpChatApp: bindChatApp,
  AcpTranscript: bindTranscript,
  AcpMessage: bindMessage,
  AcpStreamingText: bindStreamingText,
  AcpPromptInput: bindPromptInput,
  AcpConnectDialog: bindConnectDialog,
  AcpElicitationForm: bindElicitationForm,
  AcpPermissionModal: bindPermissionModal,
  AcpPermissionModeSelector: bindPermissionModeSelector,
  AcpWriteGateModal: bindWriteGateModal,
  AcpAuthSelector: bindAuthSelector,
  AcpModelSelector: bindModelSelector,
  AcpDebugPanel: bindDebugPanel,
  AcpStatusBar: bindStatusBar,
  AcpCodeBlock: bindCodeBlock,
};
