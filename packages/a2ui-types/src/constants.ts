/**
 * Protocol-level identifiers shared across the agents-js A2UI stack.
 *
 * Kept here (not in a2ui-types' upstream re-exports) so the host, gateway,
 * renderer, validator, and tests can reference a single source of truth
 * instead of re-declaring string literals.
 */

/**
 * The `_meta` field key on an ACP `ToolCallContent` that carries an A2UI
 * lifecycle message. ACP v0.18 does not standardize a discriminator for
 * A2UI payloads; the `_meta.a2ui_message` convention is the agents-js
 * extension through ACP's documented extensibility channel.
 */
export const A2UI_META_KEY = "a2ui_message";

/**
 * The AG-UI `CUSTOM` event `name` used when the gateway forwards an
 * `ACPSessionEvent { type: "surface_event" }` onto the wire. Namespaced
 * under `agents-js.*` per the Wave 4 CUSTOM-namespace discipline.
 */
export const A2UI_SURFACE_EVENT_NAME = "agents-js.a2ui.surface_event";

/**
 * Discriminator for the WS-bridge server frame that carries a verbatim
 * `A2uiMessage` from the gateway to a browser host. Used by both the
 * gateway (`apps/internal-gateway/ws-bridge.ts`) and the browser client
 * (`apps/web-ui/src/ws-client.ts`) so the wire format stays in sync.
 */
export const A2UI_WS_FRAME_TYPE = "a2ui_message";
