import type { AgentCard } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  type ExtendedAgentCardProvider,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
} from "@a2a-js/sdk/server";
import { type GatewayAgentCard, mapCapabilities } from "./discovery.ts";
import { HTTP_STATUS } from "./http-status.ts";
import { type A2ALogger, createConsoleLogger } from "./logger.ts";
import type { InitializableExecutor } from "./types.ts";

type JsonRpcId = string | number | null;

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** Default maximum request body size in bytes (4 MB). */
export const DEFAULT_MAX_REQUEST_BODY_SIZE = 4 * 1024 * 1024;

interface A2AServerStartOptions {
  hostname?: string;
  port?: number;
  /** Enable CORS headers on all responses (default: true). */
  cors?: boolean;
  /** Maximum allowed request body size in bytes (default: 4 MB). Requests exceeding this limit receive a 413 (Payload Too Large) response. */
  maxRequestBodySize?: number;
}

export interface UniversalA2AServerOptions {
  /** Provider for the extended agent card returned by `agent/getAuthenticatedExtendedCard`. Can be a static card or an async function. */
  extendedAgentCardProvider?: AgentCard | ExtendedAgentCardProvider;
  /**
   * Optional pre-routing hook consulted BEFORE the JSON-RPC path. Return
   * a `Response` to handle the request (e.g. a native AG-UI SSE
   * endpoint), or `null` to fall through to the default agent-card +
   * JSON-RPC routing. CORS is applied after the hook runs.
   *
   * This keeps protocol surface additions (AG-UI, custom healthchecks)
   * on the same port and discovery entry as the A2A JSON-RPC endpoint
   * without forcing each consumer to run a second `Bun.serve`.
   */
  additionalFetch?: (req: Request) => Promise<Response | null>;
}

const JSON_HEADERS = { "Content-Type": "application/json" };
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
/**
 * JSON-RPC error envelopes ride HTTP 200 — the error is encoded in the
 * JSON body, not at the HTTP layer. Aliasing `HTTP_STATUS.OK` as
 * `JSONRPC_HTTP_STATUS` at the JSON-RPC error call sites disambiguates
 * them from genuine success responses (SSE stream success, agent-card
 * GETs) so a future reader doesn't have to read the surrounding lines
 * to figure out which kind of "200 OK" each call site is emitting.
 */
const JSONRPC_HTTP_STATUS = HTTP_STATUS.OK;
const DEFAULT_GATEWAY_CARD_URL = "http://127.0.0.1";

function isIpv6Literal(host: string): boolean {
  return host.includes(":") && !host.startsWith("[") && !host.endsWith("]");
}

export function formatHttpAuthorityHost(host: string): string {
  return isIpv6Literal(host) ? `[${host}]` : host;
}

export function normalizeAdvertisedHost(hostname?: string): string {
  if (!hostname || hostname === "0.0.0.0" || hostname === "::") return "127.0.0.1";
  return hostname;
}

export function buildAgentCardBaseUrl(port: number, hostname?: string): string {
  return `http://${formatHttpAuthorityHost(normalizeAdvertisedHost(hostname))}:${port}`;
}

export function formatBindAddress(port: number, hostname?: string): string {
  return `${formatHttpAuthorityHost(hostname ?? "127.0.0.1")}:${port}`;
}

function extractRequestId(input: unknown): JsonRpcId {
  if (typeof input !== "object" || input === null || !("id" in input)) {
    return null;
  }

  const rawId = (input as { id?: unknown }).id;
  if (typeof rawId === "string" || typeof rawId === "number" || rawId === null) {
    return rawId;
  }

  return null;
}

function makeJsonRpcErrorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function isAsyncGeneratorResponse(input: unknown): input is AsyncGenerator<unknown> {
  return (
    typeof input === "object" &&
    input !== null &&
    Symbol.asyncIterator in input &&
    typeof (input as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

function isJsonRpcResponseEnvelope(
  input: unknown,
): input is { jsonrpc: "2.0"; id: JsonRpcId; result?: unknown; error?: unknown } {
  if (typeof input !== "object" || input === null) {
    return false;
  }

  const candidate = input as { jsonrpc?: unknown; id?: unknown };
  const validId =
    typeof candidate.id === "string" || typeof candidate.id === "number" || candidate.id === null;
  return candidate.jsonrpc === "2.0" && validId;
}

function formatSseEvent(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function formatSseErrorEvent(data: unknown): string {
  return `event: error\ndata: ${JSON.stringify(data)}\n\n`;
}

function withCors(response: Response): Response {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

export class UniversalA2AServer {
  private transportHandler: JsonRpcTransportHandler;
  private requestHandler: DefaultRequestHandler;
  private agentCard: GatewayAgentCard;
  private logger: A2ALogger;
  private additionalFetch: ((req: Request) => Promise<Response | null>) | undefined;

  constructor(
    private executor: InitializableExecutor,
    agentCard: GatewayAgentCard,
    logger: A2ALogger = createConsoleLogger("A2A Server"),
    serverOptions?: UniversalA2AServerOptions,
  ) {
    this.logger = logger;
    const taskStore = new InMemoryTaskStore();
    this.agentCard = agentCard;
    this.requestHandler = new DefaultRequestHandler(
      agentCard,
      taskStore,
      executor,
      undefined,
      undefined,
      undefined,
      serverOptions?.extendedAgentCardProvider,
    );
    this.transportHandler = new JsonRpcTransportHandler(this.requestHandler);
    this.additionalFetch = serverOptions?.additionalFetch;
  }

  public async start(options: A2AServerStartOptions | number = 0) {
    const requestedPort = typeof options === "number" ? options : (options.port ?? 0);
    const hostname = typeof options === "number" ? undefined : options.hostname;
    const corsEnabled = typeof options === "number" ? true : (options.cors ?? true);
    const maxBodySize =
      typeof options === "number"
        ? DEFAULT_MAX_REQUEST_BODY_SIZE
        : (options.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY_SIZE);

    // Initialize ACP connection to discover capabilities
    const acpInfo = await this.executor.initialize();

    // Map ACP agentCapabilities to the gateway card before serving discovery.
    mapCapabilities(acpInfo, this.agentCard);

    const handler = this.transportHandler;
    const agentCard = this.agentCard;
    const logger = this.logger;
    const applyCors = corsEnabled ? withCors : (r: Response) => r;
    const additionalFetch = this.additionalFetch;

    const server = Bun.serve({
      hostname,
      port: requestedPort,
      // Disable idle timeout — SSE streams stay open for the full LLM turn
      // which routinely exceeds Bun's default 10 s limit.
      idleTimeout: 0,
      async fetch(req) {
        // Handle CORS preflight
        if (req.method === "OPTIONS") {
          return corsEnabled
            ? new Response(null, { status: HTTP_STATUS.NO_CONTENT, headers: CORS_HEADERS })
            : new Response(null, { status: HTTP_STATUS.METHOD_NOT_ALLOWED });
        }

        // Pre-routing hook: consult any caller-provided fetch handler
        // BEFORE the JSON-RPC + agent-card paths. This is how the
        // gateway mounts a native AG-UI SSE endpoint on the same port.
        if (additionalFetch) {
          try {
            const hookResponse = await additionalFetch(req);
            if (hookResponse) {
              return applyCors(hookResponse);
            }
          } catch (hookError) {
            logger.error("additionalFetch hook threw", { error: String(hookError) });
            return applyCors(
              new Response(JSON.stringify({ error: "Internal error in additionalFetch" }), {
                status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
                headers: JSON_HEADERS,
              }),
            );
          }
        }

        const url = new URL(req.url);

        // Serve Agent Card
        if (url.pathname === "/.well-known/agent-card.json") {
          return applyCors(
            new Response(JSON.stringify(agentCard), {
              headers: JSON_HEADERS,
            }),
          );
        }

        // Handle JSON-RPC A2A requests
        if (req.method === "POST") {
          const contentLength = req.headers.get("content-length");
          if (contentLength !== null && Number(contentLength) > maxBodySize) {
            return applyCors(
              new Response(
                JSON.stringify(
                  makeJsonRpcErrorResponse(null, -32600, "Request body too large", {
                    maxBytes: maxBodySize,
                  }),
                ),
                { status: HTTP_STATUS.PAYLOAD_TOO_LARGE, headers: JSON_HEADERS },
              ),
            );
          }

          let body: unknown;

          try {
            const rawBytes = await req.arrayBuffer();
            if (rawBytes.byteLength > maxBodySize) {
              return applyCors(
                new Response(
                  JSON.stringify(
                    makeJsonRpcErrorResponse(null, -32600, "Request body too large", {
                      maxBytes: maxBodySize,
                    }),
                  ),
                  { status: HTTP_STATUS.PAYLOAD_TOO_LARGE, headers: JSON_HEADERS },
                ),
              );
            }
            body = JSON.parse(new TextDecoder().decode(rawBytes));
          } catch (error) {
            if (error instanceof SyntaxError) {
              logger.error("Failed to parse JSON body", { error: String(error) });
              return applyCors(
                new Response(
                  JSON.stringify(makeJsonRpcErrorResponse(null, -32700, "Parse error")),
                  {
                    status: JSONRPC_HTTP_STATUS,
                    headers: JSON_HEADERS,
                  },
                ),
              );
            }
            logger.error("Failed to parse JSON body", { error: String(error) });
            return applyCors(
              new Response(JSON.stringify(makeJsonRpcErrorResponse(null, -32700, "Parse error")), {
                status: JSONRPC_HTTP_STATUS,
                headers: JSON_HEADERS,
              }),
            );
          }

          const requestId = extractRequestId(body);

          try {
            // A2A 1.0: the SDK's transport handler validates the JSON-RPC
            // envelope and returns a JSON-RPC error response for malformed
            // input (unknown/missing method, bad params). We lean on that
            // rather than re-deriving A2A schemas here; the gateway is
            // internal-only, so the SDK's envelope gate plus proto decode
            // is the trust boundary.
            const result = await handler.handle(
              body as Record<string, unknown>,
              new ServerCallContext({}),
            );

            if (isAsyncGeneratorResponse(result)) {
              const stream = new ReadableStream({
                async start(controller) {
                  const encoder = new TextEncoder();

                  try {
                    for await (const event of result) {
                      const payload = isJsonRpcResponseEnvelope(event)
                        ? event
                        : {
                            jsonrpc: "2.0" as const,
                            id: requestId,
                            result: event,
                          };
                      controller.enqueue(encoder.encode(formatSseEvent(payload)));
                    }
                  } catch (streamError) {
                    logger.error("Error while streaming A2A SSE response", {
                      error: String(streamError),
                    });
                    controller.enqueue(
                      encoder.encode(
                        formatSseErrorEvent(
                          makeJsonRpcErrorResponse(requestId, -32603, "Internal error"),
                        ),
                      ),
                    );
                  } finally {
                    controller.close();
                  }
                },
              });

              return applyCors(
                new Response(stream, {
                  status: HTTP_STATUS.OK,
                  headers: SSE_HEADERS,
                }),
              );
            }

            return applyCors(
              new Response(JSON.stringify(result), {
                headers: JSON_HEADERS,
              }),
            );
          } catch (error) {
            logger.error("Error processing request", { error: String(error) });
            return applyCors(
              new Response(
                JSON.stringify(makeJsonRpcErrorResponse(requestId, -32603, "Internal error")),
                {
                  status: JSONRPC_HTTP_STATUS,
                  headers: JSON_HEADERS,
                },
              ),
            );
          }
        }

        return applyCors(new Response("Not Found", { status: HTTP_STATUS.NOT_FOUND }));
      },
    });
    const serverPort = server.port;
    if (serverPort === undefined) {
      server.stop(true);
      throw new Error("[A2A Server] Bun did not expose a bound port.");
    }

    this.finalizeDefaultUrl(serverPort, hostname);

    this.logger.info("Listening", { address: formatBindAddress(serverPort, hostname) });
    this.logger.info("Dynamically wrapped agent", {
      name: acpInfo.agentInfo?.name,
      version: acpInfo.agentInfo?.version,
    });

    return server;
  }

  private finalizeDefaultUrl(port: number | undefined, hostname?: string): void {
    if (port === undefined) {
      return;
    }
    // A2A 1.0 moved the bind URL into `supportedInterfaces[].url`. Replace the
    // placeholder interface (built by `discovery.ts` with DEFAULT_GATEWAY_CARD_URL)
    // with the actually-bound authority once Bun has allocated the port.
    const iface = this.agentCard.supportedInterfaces.find(
      (entry) => entry.url === DEFAULT_GATEWAY_CARD_URL,
    );
    if (iface) {
      iface.url = buildAgentCardBaseUrl(port, hostname);
    }
  }
}
