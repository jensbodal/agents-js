import { truncateText } from "./target.ts";
import type { DebugRecord } from "./types.ts";
import { randomUuid } from "./uuid.ts";

type FetchHeaders = Headers | string[][] | Record<string, string | readonly string[]> | undefined;
type FetchInput = Request | URL | string;

export type FetchLike = (input: FetchInput, init?: RequestInit) => Promise<Response>;

function headersToRecord(headers: FetchHeaders): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key] = typeof value === "string" ? value : value.join(", ");
  }
  return normalized;
}

function makeMergedHeaders(
  input: FetchInput,
  init: RequestInit | undefined,
  defaultHeaders: Record<string, string>,
): Headers {
  const merged = new Headers(defaultHeaders);

  if (input instanceof Request) {
    for (const [key, value] of input.headers.entries()) {
      merged.set(key, value);
    }
  }

  const initHeaders = headersToRecord(init?.headers);
  for (const [key, value] of Object.entries(initHeaders)) {
    merged.set(key, value);
  }

  return merged;
}

async function readRequestBody(
  input: FetchInput,
  init: RequestInit | undefined,
): Promise<string | undefined> {
  const body = init?.body;
  if (typeof body === "string") {
    return truncateText(body);
  }
  if (body instanceof URLSearchParams) {
    return truncateText(body.toString());
  }
  if (body instanceof Uint8Array) {
    return truncateText(new TextDecoder().decode(body));
  }
  if (body !== undefined && body !== null) {
    return truncateText(String(body));
  }
  if (input instanceof Request) {
    try {
      return truncateText(await input.clone().text());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function createDebugFetch(
  baseFetch: FetchLike,
  defaultHeaders: Record<string, string>,
  onRecord: (record: DebugRecord) => void,
): FetchLike {
  return async (input, init) => {
    const requestId = randomUuid();
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const url = input instanceof Request ? input.url : input.toString();
    const headers = makeMergedHeaders(input, init, defaultHeaders);
    const requestInit: RequestInit = {
      ...init,
      headers,
    };

    onRecord({
      requestId,
      timestamp: new Date().toISOString(),
      direction: "outbound",
      kind: "http",
      method,
      url,
      headers: Object.fromEntries(headers.entries()),
      body: await readRequestBody(input, requestInit),
    });

    try {
      const response = await baseFetch(input, requestInit);
      const responseText = await response
        .clone()
        .text()
        .catch(() => undefined);

      onRecord({
        requestId,
        timestamp: new Date().toISOString(),
        direction: "inbound",
        kind: "http",
        method,
        url,
        headers: Object.fromEntries(response.headers.entries()),
        status: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
        body: truncateText(responseText),
      });

      return response;
    } catch (error) {
      onRecord({
        requestId,
        timestamp: new Date().toISOString(),
        direction: "inbound",
        kind: "http",
        method,
        url,
        headers: {},
        body: truncateText(error instanceof Error ? error.message : String(error)),
      });
      throw error;
    }
  };
}
