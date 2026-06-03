/**
 * `@agents-js/a2ui-types` — thin wrapper over `@a2ui/web_core`.
 *
 * Re-exports the protocol surface (message schemas, `MessageProcessor`, `Catalog`,
 * `SurfaceGroupModel`, `DataContext`, signal helpers, etc.), the basic catalog APIs,
 * and the ACP custom catalog (`AcpCatalog`, `ACP_CATALOG_ID`, per-component APIs).
 *
 * See `README.md` for design rationale.
 */

export * from "@a2ui/web_core/v0_9";
export * from "@a2ui/web_core/v0_9/basic_catalog";
export * from "./catalog/index.js";
export { A2UI_META_KEY, A2UI_SURFACE_EVENT_NAME, A2UI_WS_FRAME_TYPE } from "./constants.js";
