function ensureWs(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return url;
  }
  return `ws://${url}`;
}

export function normalizeHostBridgeUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(ensureWs(trimmed));
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      return null;
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}
