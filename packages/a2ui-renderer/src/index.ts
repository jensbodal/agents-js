/**
 * `@agents-js/a2ui-renderer` — maps A2UI component trees onto the 35 `acp-*`
 * Lit primitives in `@agents-js/ui-components`.
 *
 * See `README.md` for usage and design notes.
 */

export {
  type A2uiAction,
  type A2uiEventHandler,
  ACP_BINDINGS,
  type BindingContext,
  type BindingResult,
  bindAuthSelector,
  bindChatApp,
  bindCodeBlock,
  bindConnectDialog,
  bindDebugPanel,
  bindElicitationForm,
  bindMessage,
  bindModelSelector,
  bindPermissionModal,
  bindPermissionModeSelector,
  bindPromptInput,
  bindStatusBar,
  bindStreamingText,
  bindTranscript,
  bindWriteGateModal,
  type DynamicValue,
} from "./acp-bindings.ts";
export { DEFAULT_SURFACE_ID } from "./constants.ts";
export {
  type A2uiComponentNode,
  type RenderOptions,
  renderA2uiComponent,
} from "./dispatch.ts";
export { A2uiRendererError } from "./errors.ts";
export {
  type ComponentLike,
  type RenderSurfaceOptions,
  renderSurface,
  type SurfaceGroupLike,
  type SurfaceLike,
} from "./surface-view.ts";
