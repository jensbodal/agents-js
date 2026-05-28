/**
 * `@agents-js/a2ui-host` — DOM-side host + bridge for A2UI lifecycle
 * messages. Owns one `MessageProcessor` per mount and forwards user-driven
 * surface events back through a sink.
 *
 * Consumed by `apps/web-ui` and `obsidian-acp-plugin` as the single shared
 * implementation — promoted out of two near-verbatim copies to remove
 * drift risk and to centralize the hot-reload-safe attach/detach contract.
 *
 * See `README.md` for usage and design notes.
 */

export {
  A2uiBridge,
  type A2uiBridgeOptions,
  type SurfaceEventSink,
} from "./bridge.ts";
export {
  A2uiHost,
  type A2uiHostEventHandler,
  type A2uiHostOptions,
  type SurfaceRenderer,
} from "./host.ts";
export type {
  RendererAdapter,
  RendererAdapterApplyPayload,
  RendererAdapterCaptureResult,
  RendererAdapterDimensions,
  RendererAdapterMountOptions,
  RendererAdapterPhase,
  RendererAdapterStats,
} from "./renderer-adapter.ts";
