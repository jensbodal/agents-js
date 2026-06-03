import type {
  CancelTaskRequest,
  DeleteTaskPushNotificationConfigRequest,
  GetTaskPushNotificationConfigRequest,
  GetTaskRequest,
  ListTaskPushNotificationConfigsRequest,
  SendMessageRequest,
  StreamResponse,
  SubscribeToTaskRequest,
  Task,
  TaskPushNotificationConfig,
} from "@a2a-js/sdk";
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
} from "@a2a-js/sdk/client";
import { validateAgentCard } from "@agents-js/validation/a2a";
import { createDebugFetch, type FetchLike } from "./debug.ts";
import {
  type NormalizedAgentTargetInput,
  normalizeAgentTargetInput,
  originCardFallback,
  summarizeCapabilities,
  truncateText,
} from "./target.ts";
import type {
  A2ASendResult,
  A2AStreamElement,
  A2AStreamPayload,
  A2ATransport,
  AgentTargetInput,
  DebugRecord,
  ProbeResult,
  ResolvedAgentTarget,
  TargetInspection,
} from "./types.ts";
import { randomUuid } from "./uuid.ts";

interface ResolvedClientContext {
  target: ResolvedAgentTarget;
  client: Awaited<ReturnType<ClientFactory["createFromUrl"]>>;
}

function buildProbeHeaders(headers: Record<string, string>): Headers {
  const probeHeaders = new Headers(headers);
  if (!probeHeaders.has("accept")) {
    probeHeaders.set("accept", "application/json");
  }
  return probeHeaders;
}

/**
 * Peel the A2A 1.0 `StreamResponse` envelope at the wire edge, yielding the
 * tagged `{ $case, value }` payload the provider's stream loop discriminates on.
 * Errors now surface as thrown exceptions from the SDK transport, so a payload
 * is always present on a yielded response.
 */
function unwrapStreamResponse(response: StreamResponse): A2AStreamPayload {
  if (!response.payload) {
    throw new Error("[a2a-client] Streaming response yielded an empty payload.");
  }
  return response.payload;
}

async function probeEndpoint(
  method: "GET" | "OPTIONS",
  url: string,
  headers: Record<string, string>,
): Promise<ProbeResult> {
  try {
    const response = await fetch(url, {
      method,
      headers: buildProbeHeaders(headers),
    });
    const text = await response.text();
    return {
      method,
      url,
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type") ?? undefined,
      bodySnippet: truncateText(text, 240),
    };
  } catch (error) {
    return {
      method,
      url,
      ok: false,
      status: 0,
      bodySnippet: truncateText(error instanceof Error ? error.message : String(error), 240),
    };
  }
}

function createInspectionDebugRecord(url: string, message: string): DebugRecord {
  return {
    requestId: randomUuid(),
    timestamp: new Date().toISOString(),
    direction: "inbound",
    kind: "client",
    method: "INSPECT",
    url,
    headers: {},
    body: message,
  };
}

/**
 * Default A2A transport implementation backed by the A2A SDK.
 *
 * Handles HTTP/SSE communication with A2A agents: target resolution via
 * agent card discovery, message sending (immediate and streaming),
 * task management, and connectivity probing.
 *
 * Wraps the SDK's `ClientFactory` and injects a debug-instrumented fetch
 * to emit {@link DebugRecord} events for request tracing.
 *
 * This is the **Transport** layer in the Ports & Adapters architecture.
 * It can be replaced with a custom implementation for WebSocket, in-process,
 * or mock transports.
 */
export class SdkA2ATransport implements A2ATransport {
  private readonly contexts = new WeakMap<ResolvedAgentTarget, ResolvedClientContext>();
  private readonly debugListeners = new Set<(record: DebugRecord) => void>();

  subscribeDebug(listener: (record: DebugRecord) => void): () => void {
    this.debugListeners.add(listener);
    return () => {
      this.debugListeners.delete(listener);
    };
  }

  private emitDebug(record: DebugRecord): void {
    for (const listener of this.debugListeners) {
      listener(record);
    }
  }

  async resolveTarget(input: AgentTargetInput): Promise<ResolvedAgentTarget> {
    const normalized = normalizeAgentTargetInput(input);
    try {
      return await this.resolveNormalizedTarget(normalized);
    } catch (primaryError) {
      const fallback = originCardFallback(normalized);
      if (!fallback) {
        throw primaryError;
      }
      try {
        this.emitDebug(
          createInspectionDebugRecord(
            normalized.cardUrl,
            `[a2a-client] Card fetch failed; retrying at origin: ${fallback.cardUrl}`,
          ),
        );
        return await this.resolveNormalizedTarget(fallback);
      } catch {
        throw primaryError;
      }
    }
  }

  private async resolveNormalizedTarget(
    normalized: NormalizedAgentTargetInput,
  ): Promise<ResolvedAgentTarget> {
    const debugFetch = createDebugFetch(fetch as FetchLike, normalized.headers, (record) =>
      this.emitDebug(record),
    );
    const factoryOptions = ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      clientConfig: {
        polling: true,
      },
      transports: [
        new JsonRpcTransportFactory({ fetchImpl: debugFetch as typeof fetch }),
        new RestTransportFactory({ fetchImpl: debugFetch as typeof fetch }),
      ],
      cardResolver: new DefaultAgentCardResolver({ fetchImpl: debugFetch as typeof fetch }),
    });
    const factory = new ClientFactory(factoryOptions);
    const client = await factory.createFromUrl(
      normalized.clientFactoryUrl,
      normalized.clientFactoryPath,
    );
    const card = validateAgentCard(await client.getAgentCard());

    // A2A 1.0 moved url/protocolVersion off the card top-level onto the
    // per-transport AgentInterface entries.
    const primaryInterface = card.supportedInterfaces[0];
    const cardUrl = primaryInterface?.url;
    const target: ResolvedAgentTarget = {
      baseUrl: typeof cardUrl === "string" && cardUrl.length > 0 ? cardUrl : normalized.baseUrl,
      cardUrl: normalized.cardUrl,
      card,
      protocolVersion: primaryInterface?.protocolVersion,
      capabilities: summarizeCapabilities(card),
    };

    this.contexts.set(target, { target, client });
    return target;
  }

  async inspectTarget(input: AgentTargetInput): Promise<TargetInspection> {
    let results: ProbeResult[] | undefined;

    try {
      results = await this.probe(input);
      const target = await this.resolveTarget(input);
      if (results.some((result) => result.ok)) {
        return {
          status: "ready",
          card: target.card,
          results,
        };
      }

      const error = "[a2a-client] Target did not pass any shared probe checks.";
      this.emitDebug(createInspectionDebugRecord(input.url, error));
      return {
        status: "unreachable",
        card: target.card,
        results,
        error,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitDebug(createInspectionDebugRecord(input.url, message));
      return {
        status: "unreachable",
        results,
        error: message,
      };
    }
  }

  private getContext(target: ResolvedAgentTarget): ResolvedClientContext {
    const context = this.contexts.get(target);
    if (!context) {
      throw new Error(
        "[a2a-client] Target is not bound to this transport. Resolve the target before sending messages.",
      );
    }
    return context;
  }

  async sendMessage(
    target: ResolvedAgentTarget,
    params: SendMessageRequest,
  ): Promise<A2ASendResult> {
    const { client } = this.getContext(target);
    return client.sendMessage(params);
  }

  sendMessageStream(
    target: ResolvedAgentTarget,
    params: SendMessageRequest,
  ): AsyncGenerator<A2AStreamElement> {
    const { client } = this.getContext(target);
    return (async function* () {
      for await (const event of client.sendMessageStream(params)) {
        yield unwrapStreamResponse(event);
      }
    })();
  }

  async getTask(target: ResolvedAgentTarget, params: GetTaskRequest): Promise<Task> {
    const { client } = this.getContext(target);
    return client.getTask(params);
  }

  async cancelTask(target: ResolvedAgentTarget, params: CancelTaskRequest): Promise<Task> {
    const { client } = this.getContext(target);
    return client.cancelTask(params);
  }

  resubscribeTask(
    target: ResolvedAgentTarget,
    params: SubscribeToTaskRequest,
  ): AsyncGenerator<A2AStreamElement> {
    const { client } = this.getContext(target);
    return (async function* () {
      for await (const event of client.resubscribeTask(params)) {
        yield unwrapStreamResponse(event);
      }
    })();
  }

  async setTaskPushNotificationConfig(
    target: ResolvedAgentTarget,
    params: TaskPushNotificationConfig,
  ): Promise<TaskPushNotificationConfig> {
    const { client } = this.getContext(target);
    return client.createTaskPushNotificationConfig(params);
  }

  async getTaskPushNotificationConfig(
    target: ResolvedAgentTarget,
    params: GetTaskPushNotificationConfigRequest,
  ): Promise<TaskPushNotificationConfig> {
    const { client } = this.getContext(target);
    return client.getTaskPushNotificationConfig(params);
  }

  async listTaskPushNotificationConfigs(
    target: ResolvedAgentTarget,
    params: ListTaskPushNotificationConfigsRequest,
  ): Promise<TaskPushNotificationConfig[]> {
    const { client } = this.getContext(target);
    const response = await client.listTaskPushNotificationConfig(params);
    return response.configs;
  }

  async deleteTaskPushNotificationConfig(
    target: ResolvedAgentTarget,
    params: DeleteTaskPushNotificationConfigRequest,
  ): Promise<void> {
    const { client } = this.getContext(target);
    await client.deleteTaskPushNotificationConfig(params);
  }

  async getExtendedAgentCard(
    target: ResolvedAgentTarget,
  ): Promise<import("@a2a-js/sdk").AgentCard> {
    const { client } = this.getContext(target);
    return client.transport.getExtendedAgentCard({ tenant: "" });
  }

  async probe(input: AgentTargetInput): Promise<ProbeResult[]> {
    const normalized = normalizeAgentTargetInput(input);
    const urls = [
      { method: "GET" as const, url: normalized.cardUrl },
      { method: "OPTIONS" as const, url: normalized.baseUrl },
      { method: "OPTIONS" as const, url: `${normalized.baseUrl.replace(/\/$/, "")}/rpc` },
      { method: "OPTIONS" as const, url: `${normalized.baseUrl.replace(/\/$/, "")}/jsonrpc` },
    ];

    const results = await Promise.all(
      urls.map(({ method, url }) => probeEndpoint(method, url, normalized.headers)),
    );

    for (const result of results) {
      this.emitDebug({
        requestId: randomUuid(),
        timestamp: new Date().toISOString(),
        direction: "inbound",
        kind: "probe",
        method: result.method,
        url: result.url,
        headers: {},
        status: result.status,
        contentType: result.contentType,
        body: result.bodySnippet,
      });
    }

    return results;
  }
}
