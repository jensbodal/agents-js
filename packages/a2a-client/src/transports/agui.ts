import type { BaseEvent, RunAgentInput } from "@agents-js/agui-types";
import { EventType } from "@agents-js/agui-types";
import { normalizeAgentTargetInput, summarizeCapabilities, truncateText } from "../target.ts";
import type {
  AgentTargetInput,
  DebugRecord,
  ProbeResult,
  ResolvedAgentTarget,
  TargetInspection,
} from "../types.ts";
import { randomUuid } from "../uuid.ts";
import { AGUIStreamError } from "./agui-errors.ts";
import { parseAguiSseStream } from "./agui-sse-parser.ts";

/** Options for constructing an {@link AGUITransport}. */
export interface AGUITransportOptions {
  /** Custom fetch implementation (defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
  /** Static headers applied to every outbound request. */
  headers?: Record<string, string>;
  /** Abort signal bound to the transport instance (propagates to `runAgent`). */
  signal?: AbortSignal;
}

/** Result of a single AG-UI `runAgent` call. */
export interface AGUIRunResult {
  /** Echoed / assigned thread identifier (stable across `RUN_STARTED` → terminal). */
  threadId: string;
  /** Per-run identifier assigned by the server. */
  runId: string;
  /** Stream of validated AG-UI events. Terminates after `RUN_FINISHED` or `RUN_ERROR`. */
  events: AsyncGenerator<BaseEvent, void, void>;
}

const RUN_PATH = "/agent";

/**
 * Native AG-UI client transport.
 *
 * This is a **parallel** surface to {@link A2ATransport}, not a subtype.
 * AG-UI has no task lifecycle, so the task-shaped methods on `A2ATransport`
 * have no AG-UI counterpart. Use {@link AguiToA2ATransportAdapter} for
 * backward compatibility with `A2AClientProvider`.
 *
 * Wire contract:
 * - `POST ${baseUrl}/agent`, body = `RunAgentInput` JSON
 * - Request: `Accept: text/event-stream`, `Content-Type: application/json`
 * - Response: `text/event-stream`, each frame `data: <json>\n\n`
 * - Terminal event is `RUN_FINISHED` or `RUN_ERROR`; no events follow.
 * - Request-level errors surface as HTTP 4xx JSON.
 */
export class AGUITransport {
  private readonly fetchImpl: typeof fetch;
  private readonly staticHeaders: Record<string, string>;
  private readonly parentSignal?: AbortSignal;
  private readonly debugListeners = new Set<(record: DebugRecord) => void>();

  constructor(options: AGUITransportOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.staticHeaders = options.headers ? { ...options.headers } : {};
    this.parentSignal = options.signal;
  }

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

  /**
   * Resolve an AG-UI target. AG-UI has no agent card; we synthesize one
   * from the input so downstream consumers get a uniform
   * {@link ResolvedAgentTarget} shape.
   */
  async resolveTarget(input: AgentTargetInput): Promise<ResolvedAgentTarget> {
    const normalized = normalizeAgentTargetInput({ ...input, mode: "base" });
    const baseUrl = normalized.baseUrl;
    const protocolVersion = "agui/0.0.52";
    // AG-UI has no agent card; synthesize a proto-canonical (A2A 1.0)
    // AgentCard so downstream consumers get a uniform shape.
    const card = {
      name: "agui-agent",
      description: "AG-UI native agent (no agent card).",
      supportedInterfaces: [
        { url: baseUrl, protocolBinding: "JSONRPC", tenant: "", protocolVersion },
      ],
      provider: undefined,
      version: "0.0.0",
      capabilities: { streaming: true, extensions: [] },
      securitySchemes: {},
      securityRequirements: [],
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
      skills: [],
      signatures: [],
    } as unknown as ResolvedAgentTarget["card"];
    return {
      baseUrl,
      cardUrl: `${baseUrl}${RUN_PATH}`,
      card,
      protocolVersion,
      capabilities: summarizeCapabilities(card),
    };
  }

  /**
   * Inspect an AG-UI target. Fires an `OPTIONS` probe and resolves a
   * target; reports `ready` when at least one probe succeeds.
   */
  async inspectTarget(input: AgentTargetInput): Promise<TargetInspection> {
    const results = await this.probe(input);
    try {
      const target = await this.resolveTarget(input);
      if (results.some((result) => result.ok)) {
        return { status: "ready", card: target.card, results };
      }
      return {
        status: "unreachable",
        card: target.card,
        results,
        error: "[a2a-client] AG-UI target did not pass any probe checks.",
      };
    } catch (error) {
      return {
        status: "unreachable",
        results,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * POST a `RunAgentInput` and return a stream of validated AG-UI events.
   *
   * The method is synchronous: it returns immediately with the
   * {@link AGUIRunResult} handle. Awaiting the first event drives the
   * underlying fetch.
   */
  runAgent(target: ResolvedAgentTarget, input: RunAgentInput): AGUIRunResult {
    const threadId = input.threadId;
    const runId = input.runId;
    const url = `${trimTrailingSlash(target.baseUrl)}${RUN_PATH}`;
    const signal = this.parentSignal;
    const fetchImpl = this.fetchImpl;
    const headers = this.staticHeaders;
    const emitDebug = (record: DebugRecord) => this.emitDebug(record);

    async function* generate(): AsyncGenerator<BaseEvent, void, void> {
      const requestId = randomUuid();
      const requestHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...headers,
      };
      const bodyText = JSON.stringify(input);
      emitDebug({
        requestId,
        timestamp: new Date().toISOString(),
        direction: "outbound",
        kind: "http",
        method: "POST",
        url,
        headers: requestHeaders,
        body: truncateText(bodyText, 2_000),
      });

      const response = await fetchImpl(url, {
        method: "POST",
        headers: requestHeaders,
        body: bodyText,
        signal,
      });

      const contentType = response.headers.get("content-type") ?? undefined;
      const responseHeaderSnapshot: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaderSnapshot[key] = value;
      });

      if (!response.ok) {
        const text = await response.text();
        emitDebug({
          requestId,
          timestamp: new Date().toISOString(),
          direction: "inbound",
          kind: "http",
          method: "POST",
          url,
          headers: responseHeaderSnapshot,
          status: response.status,
          contentType,
          body: truncateText(text, 2_000),
        });
        throw new AGUIStreamError(
          `[a2a-client] AG-UI server rejected run request (${response.status}): ${truncateText(
            text,
            200,
          )}`,
        );
      }

      if (!response.body) {
        throw new AGUIStreamError(
          "[a2a-client] AG-UI response had no body; expected text/event-stream.",
        );
      }

      emitDebug({
        requestId,
        timestamp: new Date().toISOString(),
        direction: "inbound",
        kind: "http",
        method: "POST",
        url,
        headers: responseHeaderSnapshot,
        status: response.status,
        contentType,
      });

      let sawRunStarted = false;
      let terminal = false;
      for await (const event of parseAguiSseStream(response.body, signal)) {
        if (terminal) {
          // Contract: no events after terminal.
          throw new AGUIStreamError(
            `[a2a-client] AG-UI stream emitted event ${String(event.type)} after terminal frame.`,
          );
        }
        if (event.type === EventType.RUN_STARTED) {
          sawRunStarted = true;
        } else if (!sawRunStarted) {
          throw new AGUIStreamError(
            `[a2a-client] AG-UI stream emitted ${String(event.type)} before RUN_STARTED.`,
          );
        }
        if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
          terminal = true;
        }
        yield event;
      }

      if (!sawRunStarted) {
        throw new AGUIStreamError("[a2a-client] AG-UI stream closed without emitting RUN_STARTED.");
      }
      if (!terminal) {
        throw new AGUIStreamError(
          "[a2a-client] AG-UI stream closed without a terminal RUN_FINISHED or RUN_ERROR frame.",
        );
      }
    }

    return { threadId, runId, events: generate() };
  }

  /**
   * Probe the AG-UI agent endpoint. AG-UI has no agent card; we send
   * `OPTIONS` requests against the base URL and the `/agent` run path.
   */
  async probe(input: AgentTargetInput): Promise<ProbeResult[]> {
    const normalized = normalizeAgentTargetInput({ ...input, mode: "base" });
    const endpoints: Array<{ method: "OPTIONS" | "GET"; url: string }> = [
      { method: "OPTIONS", url: normalized.baseUrl },
      { method: "OPTIONS", url: `${trimTrailingSlash(normalized.baseUrl)}${RUN_PATH}` },
    ];
    const probeHeaders = new Headers(normalized.headers);
    if (!probeHeaders.has("accept")) {
      probeHeaders.set("accept", "application/json");
    }

    const results = await Promise.all(
      endpoints.map(async ({ method, url }) => {
        try {
          const response = await this.fetchImpl(url, { method, headers: probeHeaders });
          const text = await response.text();
          return {
            method,
            url,
            ok: response.ok,
            status: response.status,
            contentType: response.headers.get("content-type") ?? undefined,
            bodySnippet: truncateText(text, 240),
          } as ProbeResult;
        } catch (error) {
          return {
            method,
            url,
            ok: false,
            status: 0,
            bodySnippet: truncateText(error instanceof Error ? error.message : String(error), 240),
          } as ProbeResult;
        }
      }),
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

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
