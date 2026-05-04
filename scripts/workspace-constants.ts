/**
 * Browser-safe workspace constants.
 *
 * This module intentionally avoids Node.js imports (fs, path, url) so it can
 * be consumed by both server-side scripts and browser runtime code (via Vite).
 *
 * These legacy localhost examples remain available for examples/tests that
 * need a concrete URL, but the upstream browser/dev contract now uses
 * printed discovery URLs instead of a checked-in default port.
 */
export const defaultGatewayPort = 55363;
export const defaultGatewayUrl = `http://localhost:${defaultGatewayPort}`;
export const defaultGatewayCardUrl = `${defaultGatewayUrl}/.well-known/agent-card.json`;
