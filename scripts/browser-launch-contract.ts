function extractUrlAfterLabel(
  line: string,
  label: string,
  protocols: "http" | "ws" | "any" = "http",
): string | null {
  const marker = `${label}:`;
  const index = line.indexOf(marker);
  if (index < 0) {
    return null;
  }

  const raw = line.slice(index + marker.length).trim();
  const pattern =
    protocols === "ws"
      ? /^(wss?:\/\/\S+)/
      : protocols === "any"
        ? /^((?:https?|wss?):\/\/\S+)/
        : /^(https?:\/\/\S+)/;
  return raw.match(pattern)?.[1] ?? null;
}

export function buildLauncherOpenUrl(
  webUiUrl: string,
  gatewayUrl: string,
  gatewayWsUrl: string,
): string {
  const url = new URL(webUiUrl);
  url.searchParams.set("target", gatewayUrl);
  url.searchParams.set("ws", gatewayWsUrl);
  return url.toString();
}

export function extractGatewayUrl(line: string): string | null {
  return extractUrlAfterLabel(line, "Gateway URL");
}

export function extractGatewayWsUrl(line: string): string | null {
  return extractUrlAfterLabel(line, "Gateway WS URL", "ws");
}

export function extractLauncherWebUiUrl(line: string): string | null {
  return extractUrlAfterLabel(line, "Web UI URL");
}

export function extractOpenUrl(line: string): string | null {
  return extractUrlAfterLabel(line, "Open URL", "any");
}

export function extractViteLocalUrl(line: string): string | null {
  if (!line.includes("Local:")) {
    return null;
  }

  return line.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[[^\]]+\]):\d+\/?/)?.[0] ?? null;
}
