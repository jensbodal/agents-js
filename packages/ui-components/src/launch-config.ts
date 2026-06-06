import { normalizeHostBridgeUrl } from "./host-bridge-url.ts";

function sanitizeTargetUrl(raw: string | null | undefined): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function normalizeComparableUrl(raw: string | null | undefined): string {
  return sanitizeTargetUrl(raw).replace(/\/+$/, "");
}

export interface BrowserLaunchConfig {
  defaultTargetUrl: string;
  envTargetUrl: string | null;
  hostBridgeTargetUrl: string | null;
  hostBridgeUrl: string | null;
  queryTargetUrl: string | null;
  queryWsUrl: string | null;
  restoreSavedRuntime: boolean;
  savedTargetUrl: string | null;
}

export interface ResolveBrowserLaunchConfigOptions {
  envTargetUrl?: string | null | undefined;
  envWsUrl?: string | null | undefined;
  savedUrl?: string | null | undefined;
  search: string | URLSearchParams;
}

export function isHostBridgeActiveForTarget(
  activeTargetUrl: string | null | undefined,
  hostBridgeTargetUrl: string | null | undefined,
): boolean {
  const expected = normalizeComparableUrl(hostBridgeTargetUrl);
  if (!expected) {
    return false;
  }
  return normalizeComparableUrl(activeTargetUrl) === expected;
}

export function resolveBrowserLaunchConfig(
  options: ResolveBrowserLaunchConfigOptions,
): BrowserLaunchConfig {
  const params =
    options.search instanceof URLSearchParams
      ? options.search
      : new URLSearchParams(options.search);

  const hasQueryTarget = params.has("target");
  const hasQueryWs = params.has("ws");

  const queryTargetUrl = hasQueryTarget ? sanitizeTargetUrl(params.get("target")) : "";
  const savedTargetUrl = sanitizeTargetUrl(options.savedUrl);
  const envTargetUrl = sanitizeTargetUrl(options.envTargetUrl);

  const queryWsUrl = hasQueryWs ? normalizeHostBridgeUrl(params.get("ws")) : null;
  const envWsUrl = hasQueryWs ? null : normalizeHostBridgeUrl(options.envWsUrl);
  const restoreSavedRuntime = !(hasQueryTarget && queryWsUrl);

  const defaultTargetUrl = hasQueryTarget ? queryTargetUrl : savedTargetUrl || envTargetUrl || "";

  const hostBridgeTargetUrl = hasQueryTarget ? queryTargetUrl : envTargetUrl || "";
  const hostBridgeUrl = queryWsUrl ?? envWsUrl ?? null;

  return {
    defaultTargetUrl,
    queryTargetUrl: hasQueryTarget ? queryTargetUrl : null,
    savedTargetUrl: savedTargetUrl || null,
    restoreSavedRuntime,
    envTargetUrl: envTargetUrl || null,
    queryWsUrl,
    hostBridgeUrl: hostBridgeUrl && hostBridgeTargetUrl ? hostBridgeUrl : null,
    hostBridgeTargetUrl: hostBridgeUrl && hostBridgeTargetUrl ? hostBridgeTargetUrl : null,
  };
}
