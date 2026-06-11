import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hostname as osHostname } from "node:os";
import { type AgentCard, TaskState } from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
} from "@a2a-js/sdk/server";
import {
  buildAgentCard,
  buildAgentCardBaseUrl,
  buildStatusUpdate,
  CURRENT_A2A_PROTOCOL_VERSION,
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  type ExecutionEventBus,
  getMessageText,
  type InitializableExecutor,
  nowIso,
  type RequestContext,
} from "@agents-js/a2a";
import {
  A2AClientProvider,
  type A2AEvent,
  extractA2AResponseText,
  extractLatestAgentText,
  parseAgentMentions,
  parseDispatchDirective,
  stripMention,
} from "@agents-js/a2a-client";
import {
  type AutoRegisterHeartbeatHandle,
  autoRegister,
  readAgentRegistryRecords,
  resolveSharedAgentRegistryPath,
  startAutoRegisterHeartbeat,
} from "@agents-js/a2a-client/node";
import {
  type HostnameSource,
  type NetworkInterfacesSource,
  resolveLanAdvertiseHost,
} from "@agents-js/agent-launch";
import pkg from "../package.json";
import type { PiCustomMessage, PiHost } from "./types.ts";

const NATIVE_MESSAGE_TYPE = "agents-js.native-pi";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;
// Native pi re-advertises its address on this cadence so the peer survives a
// host LAN-IP change without a relaunch. 30s (vs the gateway's 60s) because an
// IP change is a hard reachability outage for pi, so faster mesh re-convergence
// matters; the per-tick cost is one interface read + one small registry write.
const DEFAULT_PI_HEARTBEAT_INTERVAL_MS = 30_000;
const EXTENSION_PROMPT_MARK_LIMIT = 64;
const JSON_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};
const SSE_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "Content-Type": "text/event-stream",
  "X-Accel-Buffering": "no",
};

type Logger = Pick<Console, "error" | "log" | "warn">;

export interface NativePiPeerOptions {
  env?: Record<string, string | undefined>;
  logger?: Logger;
  /**
   * Test seam: source of network interfaces for re-detecting the advertised
   * LAN host on each heartbeat tick. Defaults to `os.networkInterfaces`.
   */
  interfacesSource?: NetworkInterfacesSource;
  /** Test seam: source of the host short-name for the FQDN advertise path. */
  hostnameSource?: HostnameSource;
  /**
   * Test seam: scheduler for the re-advertise heartbeat. Defaults to
   * `setTimeout`/`clearTimeout`; injected so tests can drive ticks deterministically.
   */
  scheduler?: {
    setTimeout: (cb: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

export interface NativePiPeerHandle {
  enabled: boolean;
  getUrl(): string | null;
  name?: string;
  stop(): Promise<void>;
}

interface NativePiPeerConfig {
  /** Host published in the agent-card/registry (peers connect here). */
  advertiseHost: string;
  /** Host the socket binds to (0.0.0.0 for LAN advertise — survives IP churn). */
  bindHost: string;
  /** Re-advertise cadence (ms); 0 disables periodic re-advertise. */
  heartbeatIntervalMs: number;
  /** Optional LAN domain → advertise a stable `<host>.<domain>` FQDN (off by default). */
  lanDomain?: string;
  name: string;
  port: number;
  registryPath: string;
  timeoutMs: number;
}

interface NativeServerHandle {
  port: number;
  stop(): Promise<void>;
  url: string;
}

interface PendingPiTurn {
  clear(): void;
  reject(error: Error): void;
  resolve(text: string): void;
  textBuffer: string;
  /**
   * Streaming callback invoked with the CUMULATIVE accumulated text each time
   * pi emits an incremental `text_delta`. The A2A executor uses it to publish
   * progressive `WORKING` status updates so the client renders the response as
   * it streams instead of waiting (and timing out) for the terminal task.
   */
  onDelta?: (cumulative: string) => void;
}

function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readNativeConfig(env: Record<string, string | undefined>): NativePiPeerConfig | null {
  if (env.AGENTS_JS_PI_NATIVE !== "1") {
    return null;
  }

  const name = env.AGENTS_JS_PI_NAME?.trim();
  if (!name) {
    throw new Error("AGENTS_JS_PI_NAME is required when AGENTS_JS_PI_NATIVE=1.");
  }

  const rawPort = env.AGENTS_JS_PI_PORT?.trim() || String(DEFAULT_PORT);
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid AGENTS_JS_PI_PORT: ${rawPort}`);
  }

  const rawTimeout = env.AGENTS_JS_PI_TURN_TIMEOUT_MS?.trim();
  const timeoutMs =
    rawTimeout === undefined || rawTimeout === ""
      ? DEFAULT_TURN_TIMEOUT_MS
      : Number.parseInt(rawTimeout, 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid AGENTS_JS_PI_TURN_TIMEOUT_MS: ${rawTimeout}`);
  }

  const advertiseHost = env.AGENTS_JS_PI_HOST?.trim() || DEFAULT_HOST;
  // Bind the ADVERTISED host by default — NOT 0.0.0.0. A native pi's inbound
  // A2A is not yet authenticated, so defaulting to all-interfaces would silently
  // widen that unauth surface from one LAN segment to every host interface incl.
  // the tailnet (security review, PR #216). To survive a host IP change, either
  // advertise a STABLE address (an FQDN via AGENTS_JS_PI_LAN_DOMAIN, or a tailnet
  // IP that doesn't rotate) or set AGENTS_JS_PI_BIND_HOST=0.0.0.0 explicitly,
  // accepting the wider exposure. Enforcing signed-peer auth on the inbound
  // handler (which would make 0.0.0.0 safe) is a separate follow-up.
  const bindHost = env.AGENTS_JS_PI_BIND_HOST?.trim() || advertiseHost;

  const rawHeartbeat = env.AGENTS_JS_PI_HEARTBEAT_INTERVAL_MS?.trim();
  const heartbeatIntervalMs =
    rawHeartbeat === undefined || rawHeartbeat === ""
      ? DEFAULT_PI_HEARTBEAT_INTERVAL_MS
      : Number.parseInt(rawHeartbeat, 10);
  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 0) {
    throw new Error(`Invalid AGENTS_JS_PI_HEARTBEAT_INTERVAL_MS: ${rawHeartbeat}`);
  }

  return {
    advertiseHost,
    bindHost,
    heartbeatIntervalMs,
    lanDomain: env.AGENTS_JS_PI_LAN_DOMAIN?.trim() || undefined,
    name,
    port,
    registryPath: resolveSharedAgentRegistryPath({
      env: env as NodeJS.ProcessEnv,
    }),
    timeoutMs,
  };
}

function extractEventText(event: unknown, key: "prompt" | "text"): string | null {
  if (!isObject(event)) {
    return null;
  }
  const value = event[key];
  return typeof value === "string" ? value : null;
}

function extractSource(event: unknown): string | null {
  if (!isObject(event)) {
    return null;
  }
  const source = event.source;
  return typeof source === "string" ? source : null;
}

function collectText(input: unknown, out: string[] = []): string[] {
  if (input === null || input === undefined) {
    return out;
  }
  if (typeof input === "string") {
    out.push(input);
    return out;
  }
  if (Array.isArray(input)) {
    for (const value of input) {
      collectText(value, out);
    }
    return out;
  }
  if (!isObject(input)) {
    return out;
  }
  if (
    (input.type === "text" || input.kind === "text") &&
    typeof input.text === "string" &&
    input.text.length > 0
  ) {
    out.push(input.text);
    return out;
  }
  for (const value of Object.values(input)) {
    collectText(value, out);
  }
  return out;
}

function extractAssistantMessageText(message: unknown): string {
  if (!isObject(message)) {
    return "";
  }
  const role = message.role;
  if (role !== undefined && role !== "assistant" && role !== "agent") {
    return "";
  }
  return collectText(message.content ?? message.parts ?? message).join("");
}

function extractAssistantTextFromAgentEnd(event: unknown): string {
  if (!isObject(event) || !Array.isArray(event.messages)) {
    return "";
  }
  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const text = extractAssistantMessageText(event.messages[index]);
    if (text.trim().length > 0) {
      return text;
    }
  }
  return "";
}

function extractMessageUpdateDelta(event: unknown): string {
  if (!isObject(event)) {
    return "";
  }

  const assistantEvent = event.assistantMessageEvent;
  if (isObject(assistantEvent)) {
    const eventType = assistantEvent.type;
    const delta = assistantEvent.delta;
    if (eventType === "text_delta" && typeof delta === "string") {
      return delta;
    }
  }

  const delta = event.delta;
  return typeof delta === "string" ? delta : "";
}

function extractErrorEventText(event: unknown): string {
  if (!isObject(event)) {
    return "Native Pi turn failed.";
  }
  for (const key of ["message", "error", "reason"] as const) {
    const value = event[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
    if (isObject(value) && typeof value.message === "string" && value.message.trim().length > 0) {
      return value.message;
    }
  }
  return "Native Pi turn failed.";
}

function createPiMessage(content: string, details?: Record<string, unknown>): PiCustomMessage {
  return {
    customType: NATIVE_MESSAGE_TYPE,
    content,
    display: true,
    ...(details ? { details } : {}),
  };
}

async function displayPiMessage(
  pi: PiHost,
  logger: Logger,
  content: string,
  details?: Record<string, unknown>,
): Promise<void> {
  if (pi.sendMessage) {
    await pi.sendMessage(createPiMessage(content, details));
    return;
  }
  // Pi owns stdout for the TUI; route the fallback to stderr.
  logger.error(`[agents-js/native-pi] ${content}`);
}

function formatDirectReply(agentName: string, response: string): string {
  return [`A2A direct reply from ${agentName}:`, "", response || "(no response)"].join("\n");
}

function formatDelegationContext(
  responses: Array<{ agentName: string; prompt: string; response: string }>,
): string {
  const blocks = responses.map(({ agentName, prompt, response }) =>
    [
      `--- ${agentName} ---`,
      `Prompt: ${prompt || "(empty)"}`,
      "",
      response || "(no response)",
    ].join("\n"),
  );
  return ["A2A peer context for this turn:", "", ...blocks].join("\n");
}

// Keyed by raw prompt text since the Pi event surface lacks a stable
// message id. Bounded to prevent unbounded growth if before_agent_start
// never fires for a marked prompt (cancel/reject upstream).
function markPrompt(map: Map<string, number>, prompt: string): void {
  if (!map.has(prompt) && map.size >= EXTENSION_PROMPT_MARK_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
  map.set(prompt, (map.get(prompt) ?? 0) + 1);
}

function consumePromptMark(map: Map<string, number>, prompt: string): boolean {
  const count = map.get(prompt) ?? 0;
  if (count <= 0) {
    return false;
  }
  if (count === 1) {
    map.delete(prompt);
  } else {
    map.set(prompt, count - 1);
  }
  return true;
}

function isAsyncGeneratorResponse(input: unknown): input is AsyncGenerator<unknown> {
  return (
    typeof input === "object" &&
    input !== null &&
    Symbol.asyncIterator in input &&
    typeof (input as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

function extractRequestId(input: unknown): null | number | string {
  if (!isObject(input)) {
    return null;
  }
  const id = input.id;
  return typeof id === "string" || typeof id === "number" || id === null ? id : null;
}

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = req.headers["content-length"];
  if (typeof declared === "string" && Number(declared) > maxBytes) {
    throw new RequestTooLargeError(maxBytes);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new RequestTooLargeError(maxBytes);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? JSON.parse(raw) : {};
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function writeJsonRpcError(
  res: ServerResponse,
  requestId: null | number | string,
  code: number,
  message: string,
  options: { data?: unknown; status?: number } = {},
): void {
  const error: { code: number; message: string; data?: unknown } = { code, message };
  if (options.data !== undefined) {
    error.data = options.data;
  }
  writeJson(res, options.status ?? 200, {
    jsonrpc: "2.0",
    id: requestId,
    error,
  });
}

async function writeSse(res: ServerResponse, stream: AsyncGenerator<unknown>): Promise<void> {
  res.writeHead(200, SSE_HEADERS);
  try {
    for await (const event of stream) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } finally {
    res.end();
  }
}

const EVENTS_KEEPALIVE_MS = 15_000;

/**
 * In-process broadcast hub. The executor TEEs every AgentEvent it
 * publishes through {@link EventHub.broadcast}; the `GET /events` route
 * registers one {@link EventHub.subscribe} callback per connected
 * observer. Subscribers are decoupled from the per-task A2A event bus so
 * a read-only observer never participates in (and cannot perturb) the
 * real JSON-RPC turn lifecycle.
 */
export interface EventHub {
  broadcast(event: unknown): void;
  subscribe(fn: (event: unknown) => void): () => void;
  subscriberCount(): number;
}

export function createEventHub(): EventHub {
  const subscribers = new Set<(event: unknown) => void>();
  return {
    broadcast(event) {
      // Snapshot so a subscriber that unsubscribes during dispatch
      // doesn't mutate the set mid-iteration. Each subscriber is isolated:
      // one throwing observer must not drop the event for the others (and,
      // combined with the tee's catch, must not reach the real event bus).
      for (const fn of [...subscribers]) {
        try {
          fn(event);
        } catch {
          // Observe-only: a broken subscriber never interferes with delivery.
        }
      }
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    subscriberCount() {
      return subscribers.size;
    },
  };
}

/**
 * Wrap an {@link ExecutionEventBus} so every `publish(event)` is also
 * mirrored to the hub, transparently. All other methods (`finished`,
 * subscriptions, etc.) delegate to the real bus unchanged.
 *
 * **Isolation invariant.** The authoritative task lifecycle MUST advance
 * unconditionally, so `publish` runs the REAL bus FIRST and captures its result;
 * the `/events` mirror is then strictly best-effort, wrapped in try/catch. A
 * throwing observer/subscriber (or a hub failure) can never stop the underlying
 * `ExecutionEventBus.publish` or task completion — the firehose only observes.
 */
export function teeEventBus(bus: ExecutionEventBus, hub: EventHub): ExecutionEventBus {
  return new Proxy(bus, {
    get(target, prop, receiver) {
      if (prop === "publish") {
        return (event: AgentEvent) => {
          const result = target.publish(event);
          try {
            hub.broadcast(event);
          } catch {
            // Swallow: the diagnostic mirror is non-interfering by contract.
          }
          return result;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function writeEventsStream(
  req: IncomingMessage,
  res: ServerResponse,
  hub: EventHub,
  active: Set<() => void>,
): void {
  res.writeHead(200, SSE_HEADERS);
  res.write(": connected\n\n");

  let closed = false;
  const safeWrite = (chunk: string): void => {
    if (closed) {
      return;
    }
    res.write(chunk);
  };

  const unsubscribe = hub.subscribe((event) => {
    safeWrite(`data: ${JSON.stringify(event)}\n\n`);
  });

  const keepAlive = setInterval(() => {
    safeWrite(": ping\n\n");
  }, EVENTS_KEEPALIVE_MS);

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(keepAlive);
    unsubscribe();
    active.delete(close);
    res.end();
  };

  active.add(close);
  req.on("close", close);
  res.on("close", close);
}

async function startNativeA2AServer(options: {
  advertiseHost: string;
  bindHost: string;
  card: AgentCard;
  executor: InitializableExecutor;
  hub: EventHub;
  logger: Logger;
  port: number;
}): Promise<NativeServerHandle> {
  await options.executor.initialize();
  const requestHandler = new DefaultRequestHandler(
    options.card,
    new InMemoryTaskStore(),
    options.executor,
  );
  const transportHandler = new JsonRpcTransportHandler(requestHandler);
  // Active `GET /events` stream closers, ended on stop() so a long-lived
  // SSE observer doesn't keep `server.close()` from resolving.
  const activeEventStreams = new Set<() => void>();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, JSON_HEADERS);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
      writeJson(res, 200, options.card);
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      writeEventsStream(req, res, options.hub, activeEventStreams);
      return;
    }

    if (req.method !== "POST") {
      writeJson(res, 404, { error: "Not Found" });
      return;
    }

    let body: unknown;
    try {
      body = await readRequestBody(req, DEFAULT_MAX_REQUEST_BODY_SIZE);
    } catch (error) {
      if (error instanceof RequestTooLargeError) {
        writeJsonRpcError(res, null, -32600, "Request body too large", {
          data: { maxBytes: error.maxBytes },
          status: 413,
        });
        return;
      }
      writeJsonRpcError(res, null, -32700, "Parse error");
      return;
    }

    const requestId = extractRequestId(body);
    try {
      const result = await transportHandler.handle(
        body as Record<string, unknown>,
        new ServerCallContext({}),
      );
      if (isAsyncGeneratorResponse(result)) {
        await writeSse(res, result);
        return;
      }
      writeJson(res, 200, result);
    } catch (error) {
      options.logger.error("[agents-js/native-pi] Error processing request:", formatError(error));
      writeJsonRpcError(res, requestId, -32603, "Internal error");
    }
  });

  const { port, bindHost, advertiseHost } = options;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bindHost, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = isObject(address) && typeof address.port === "number" ? address.port : port;
  const url = buildAgentCardBaseUrl(actualPort, advertiseHost);
  // A2A 1.0 moved the bind URL into `supportedInterfaces[].url`.
  const iface = options.card.supportedInterfaces[0];
  if (iface) {
    iface.url = url;
  }

  return {
    port: actualPort,
    url,
    async stop() {
      // End every open /events stream first (clears its keep-alive timer
      // and unsubscribes from the hub) so server.close() can resolve.
      for (const close of [...activeEventStreams]) {
        close();
      }
      await closeServer(server);
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

class NativePiBusyError extends Error {
  constructor() {
    super("Native Pi session is busy; only one inbound A2A turn is supported at a time.");
    this.name = "NativePiBusyError";
  }
}

class RequestTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes.`);
    this.name = "RequestTooLargeError";
  }
}

class NativePiTurnRunner {
  private agentActive = false;
  private pending: PendingPiTurn | null = null;

  constructor(
    private readonly pi: PiHost,
    private readonly timeoutMs: number,
  ) {}

  attach(): void {
    const failPendingTurn = (event: unknown) => {
      const pending = this.pending;
      if (!pending) {
        // User-typed turn (no inbound A2A pending) can still leave agentActive
        // set after agent_start. Clear it so the peer doesn't strand "busy".
        this.agentActive = false;
        return;
      }
      this.pending = null;
      this.agentActive = false;
      pending.clear();
      pending.reject(new Error(extractErrorEventText(event)));
    };

    this.pi.on("agent_start", () => {
      this.agentActive = true;
    });

    this.pi.on("message_update", (event: unknown) => {
      const delta = extractMessageUpdateDelta(event);
      if (delta && this.pending) {
        this.pending.textBuffer += delta;
        // Forward the cumulative text so the A2A executor can emit a streaming
        // status update for this chunk.
        this.pending.onDelta?.(this.pending.textBuffer);
      }
    });

    this.pi.on("message_end", (event: unknown) => {
      if (!this.pending || this.pending.textBuffer.trim().length > 0) {
        return;
      }
      if (!isObject(event)) {
        return;
      }
      const text = extractAssistantMessageText(event.message);
      if (text.trim().length > 0) {
        this.pending.textBuffer = text;
      }
    });

    this.pi.on("agent_end", (event: unknown) => {
      this.agentActive = false;
      const pending = this.pending;
      if (!pending) {
        return;
      }
      this.pending = null;
      pending.clear();
      const finalText = pending.textBuffer || extractAssistantTextFromAgentEnd(event);
      pending.resolve(finalText || "(no response)");
    });

    this.pi.on("agent_error", failPendingTurn);
    this.pi.on("error", failPendingTurn);
    this.pi.on("extension_error", failPendingTurn);
  }

  readonly extensionOriginPrompts = new Map<string, number>();

  isBusy(): boolean {
    return this.pending !== null || this.agentActive;
  }

  async runPrompt(
    text: string,
    signal?: AbortSignal,
    onDelta?: (cumulative: string) => void,
  ): Promise<string> {
    if (!this.pi.sendUserMessage) {
      throw new Error("Pi host does not expose sendUserMessage().");
    }
    if (this.isBusy()) {
      throw new NativePiBusyError();
    }
    if (signal?.aborted) {
      throw new Error("Native Pi turn aborted.");
    }

    return new Promise<string>((resolve, reject) => {
      let pending: PendingPiTurn;

      const onAbort = () => {
        if (this.pending !== pending) {
          return;
        }
        this.pending = null;
        this.agentActive = false;
        pending.reject(new Error("Native Pi turn aborted."));
      };

      const timer = setTimeout(() => {
        if (this.pending === pending) {
          this.pending = null;
          this.agentActive = false;
        }
        pending.reject(
          new Error(`Timed out waiting for native Pi turn after ${this.timeoutMs}ms.`),
        );
      }, this.timeoutMs);

      pending = {
        textBuffer: "",
        onDelta,
        clear: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        },
        reject: (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
        resolve: (value) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
      };
      this.pending = pending;
      signal?.addEventListener("abort", onAbort, { once: true });

      Promise.resolve(this.pi.sendUserMessage(text)).catch((error: unknown) => {
        if (this.pending === pending) {
          this.pending = null;
          this.agentActive = false;
        }
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }
}

class NativePiExecutor implements InitializableExecutor {
  private readonly inflight = new Map<string, { contextId: string; controller: AbortController }>();

  constructor(
    private readonly name: string,
    private readonly turnRunner: NativePiTurnRunner,
    private readonly hub: EventHub,
  ) {}

  async initialize() {
    return {
      protocolVersion: 1,
      agentInfo: {
        name: this.name,
        version: pkg.version,
      },
      agentCapabilities: {
        loadSession: false,
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: { image: false },
      },
    };
  }

  async execute(context: RequestContext, rawEventBus: ExecutionEventBus): Promise<void> {
    // TEE every published AgentEvent into the broadcast hub. The proxy is
    // transparent: it forwards publish() to the real bus (preserving order
    // and count) and delegates all other methods unchanged.
    const eventBus = teeEventBus(rawEventBus, this.hub);
    const userMessage = context.userMessage;
    eventBus.publish(
      AgentEvent.task({
        id: context.taskId,
        contextId: context.contextId,
        status: {
          state: TaskState.TASK_STATE_SUBMITTED,
          timestamp: nowIso(),
          message: undefined,
        },
        artifacts: [],
        history: [userMessage],
        metadata: undefined,
      }),
    );

    // One stable message id for the whole streamed turn, so the client computes
    // incremental deltas against a single growing message (the WORKING deltas
    // and the terminal message share it) instead of treating each chunk as a
    // new message.
    const streamMessageId = crypto.randomUUID();

    if (this.turnRunner.isBusy()) {
      // A2A 1.0 streaming: the turn opened with an `AgentEvent.task` (SUBMITTED)
      // above, so every later event MUST be a statusUpdate/artifactUpdate — a
      // second `task` event is a stream-ordering violation. Terminate with a
      // terminal-state statusUpdate (matches the host executor's pattern).
      eventBus.publish(
        AgentEvent.statusUpdate(
          buildStatusUpdate(context.taskId, context.contextId, {
            state: TaskState.TASK_STATE_FAILED,
            text: "Native Pi session is busy; retry after the current turn finishes.",
            messageId: streamMessageId,
          }),
        ),
      );
      eventBus.finished();
      return;
    }

    const controller = new AbortController();
    this.inflight.set(context.taskId, { contextId: context.contextId, controller });

    eventBus.publish(
      AgentEvent.statusUpdate(
        buildStatusUpdate(context.taskId, context.contextId, {
          state: TaskState.TASK_STATE_WORKING,
        }),
      ),
    );

    try {
      const prompt = getMessageText(userMessage);
      const onDelta = (cumulative: string) => {
        eventBus.publish(
          AgentEvent.statusUpdate(
            buildStatusUpdate(context.taskId, context.contextId, {
              state: TaskState.TASK_STATE_WORKING,
              text: cumulative,
              messageId: streamMessageId,
            }),
          ),
        );
      };
      const responseText = await this.turnRunner.runPrompt(prompt, controller.signal, onDelta);
      eventBus.publish(
        AgentEvent.statusUpdate(
          buildStatusUpdate(context.taskId, context.contextId, {
            state: controller.signal.aborted
              ? TaskState.TASK_STATE_CANCELED
              : TaskState.TASK_STATE_COMPLETED,
            text: responseText || "(no response)",
            messageId: streamMessageId,
          }),
        ),
      );
    } catch (error) {
      eventBus.publish(
        AgentEvent.statusUpdate(
          buildStatusUpdate(context.taskId, context.contextId, {
            state: controller.signal.aborted
              ? TaskState.TASK_STATE_CANCELED
              : TaskState.TASK_STATE_FAILED,
            messageId: streamMessageId,
            text: formatError(error),
          }),
        ),
      );
    } finally {
      this.inflight.delete(context.taskId);
      eventBus.finished();
    }
  }

  async cancelTask(taskId: string, rawEventBus: ExecutionEventBus): Promise<void> {
    const eventBus = teeEventBus(rawEventBus, this.hub);
    const entry = this.inflight.get(taskId);
    if (entry) {
      entry.controller.abort();
      eventBus.publish(
        AgentEvent.statusUpdate(
          buildStatusUpdate(taskId, entry.contextId, {
            state: TaskState.TASK_STATE_CANCELED,
            text: "Native Pi task canceled.",
          }),
        ),
      );
      eventBus.finished();
      return;
    }
    // Task not in flight (already terminal or never started). Publish a
    // terminal canceled signal anyway so the SDK's post-cancel store check
    // passes; the SDK ignores the contextId here.
    eventBus.publish(
      AgentEvent.statusUpdate(
        buildStatusUpdate(taskId, crypto.randomUUID(), {
          state: TaskState.TASK_STATE_CANCELED,
          text: "Native Pi task cancellation requested (no in-flight turn).",
        }),
      ),
    );
    eventBus.finished();
  }
}

class NativeDispatchClient {
  private readonly contexts = new Map<string, string>();
  private readonly provider = new A2AClientProvider();

  constructor(private readonly registryPath: string) {}

  async dispatch(agentName: string, message: string): Promise<string> {
    const records = await readAgentRegistryRecords({ configPath: this.registryPath });
    const record = records.find(
      (candidate) => candidate.kind === "a2a" && candidate.name === agentName,
    );
    if (!record?.url) {
      throw new Error(`No A2A agent named "${agentName}" is registered.`);
    }

    let latestText = "";
    const unsubscribe = this.provider.subscribe((event: A2AEvent) => {
      if (event.type === "message.delta") {
        latestText = event.text;
      } else if (event.type === "message.completed") {
        latestText = event.text;
      } else if (event.type === "task.updated") {
        latestText = extractLatestAgentText(event.task) || latestText;
      }
    });

    try {
      const target = await this.provider.connect({ url: record.url });
      const contextId = this.contexts.get(agentName) ?? crypto.randomUUID();
      this.contexts.set(agentName, contextId);
      const canStream = target.capabilities.supportsStreaming;
      const result = await this.provider.sendTurn(target, message, {
        contextId,
        stream: canStream,
        blocking: !canStream,
      });
      // A2A 1.0 dropped the `kind` discriminator from Message; the
      // a2a-client helper distinguishes Message (`messageId`) from Task
      // (`id`) at the wire boundary and extracts the reply text.
      const finalText = extractA2AResponseText(result);
      return finalText || latestText || "(no response)";
    } finally {
      unsubscribe();
    }
  }
}

export function installNativePeerBridge(
  pi: PiHost,
  options: NativePiPeerOptions = {},
): NativePiPeerHandle {
  const logger = options.logger ?? console;
  let config: NativePiPeerConfig | null = null;

  try {
    // biome-ignore lint/style/noProcessEnv: native Pi mode is configured by documented launch environment variables.
    config = readNativeConfig(options.env ?? process.env);
  } catch (error) {
    logger.error("[agents-js/native-pi] Invalid native peer configuration:", formatError(error));
    return {
      enabled: false,
      getUrl: () => null,
      async stop() {},
    };
  }

  if (!config) {
    return {
      enabled: false,
      getUrl: () => null,
      async stop() {},
    };
  }

  const turnRunner = new NativePiTurnRunner(pi, config.timeoutMs);
  turnRunner.attach();
  const dispatcher = new NativeDispatchClient(config.registryPath);
  // Shared broadcast hub: the executor tees its A2A events into it and the
  // `GET /events` route subscribes observers to it.
  const eventHub = createEventHub();
  const executor = new NativePiExecutor(config.name, turnRunner, eventHub);
  const card = buildAgentCard({
    name: config.name,
    description: `Native Pi TUI peer ${config.name}`,
    capabilities: {
      "text-to-text": {},
      // Streaming is the default across agents-js (ACP serves advertise it via
      // mapCapabilities); the native-peer emits incremental WORKING status
      // updates from pi's text deltas (see NativePiExecutor.execute), so the
      // client streams the reply instead of polling for the terminal task.
      streaming: true,
      extensions: [],
    },
  });

  let serverHandle: NativeServerHandle | null = null;
  let heartbeat: AutoRegisterHeartbeatHandle | null = null;

  // Host to advertise right now. Loopback advertise stays static (single
  // machine; never sniff interfaces). Otherwise re-detect the current LAN
  // address each call so the peer survives a host IP change — reusing the same
  // detection the launcher used at boot. `lanDomain`, when set, yields a stable
  // `<host>.<domain>` FQDN (the bridge to the DNS self-update lane).
  const isLoopbackHost = (h: string): boolean =>
    h === "127.0.0.1" || h === "localhost" || h === "::1";
  const resolveCurrentAdvertiseHost = (): string => {
    if (isLoopbackHost(config.advertiseHost)) return config.advertiseHost;
    return (
      resolveLanAdvertiseHost({
        lanDomain: config.lanDomain,
        interfacesSource: options.interfacesSource,
        hostnameSource: options.hostnameSource,
      }) ?? config.advertiseHost
    );
  };

  pi.on("session_start", async () => {
    if (serverHandle) {
      return;
    }
    try {
      serverHandle = await startNativeA2AServer({
        advertiseHost: config.advertiseHost,
        bindHost: config.bindHost,
        card,
        executor,
        hub: eventHub,
        logger,
        port: config.port,
      });
      const serverPort = serverHandle.port;
      // Recompute the advertised URL (re-detecting the host) and refresh the
      // served agent-card in lockstep with the registry record below.
      const computeUrl = (): string => {
        const url = buildAgentCardBaseUrl(serverPort, resolveCurrentAdvertiseHost());
        const iface = card.supportedInterfaces[0];
        if (iface) {
          iface.url = url;
        }
        return url;
      };
      const registerCurrent = (url: string): Promise<unknown> =>
        autoRegister({
          name: config.name,
          kind: "a2a",
          url,
          configPath: config.registryPath,
          gatewayId: osHostname(),
          protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
          description: card.description,
          healthCheckUrl: `${url}/.well-known/agent-card.json`,
        });
      // Boot registration is awaited so a reader right after session_start sees
      // the record; the heartbeat then re-publishes the (possibly changed) URL
      // on each tick, keeping the registry + served card fresh across IP changes.
      await registerCurrent(computeUrl());
      heartbeat = startAutoRegisterHeartbeat({
        name: config.name,
        url: computeUrl,
        configPath: config.registryPath,
        gatewayId: osHostname(),
        intervalMs: config.heartbeatIntervalMs,
        logger,
        registerFn: (opts) => {
          const url =
            typeof (opts as { url?: unknown }).url === "string"
              ? (opts as { url: string }).url
              : (serverHandle?.url ?? "");
          return registerCurrent(url);
        },
        ...(options.scheduler ? { scheduler: options.scheduler } : {}),
      });
      await displayPiMessage(
        pi,
        logger,
        `Native Pi A2A peer "${config.name}" listening at ${serverHandle.url}`,
        { name: config.name, url: serverHandle.url },
      );
    } catch (error) {
      logger.error("[agents-js/native-pi] Failed to start native peer:", formatError(error));
      await displayPiMessage(
        pi,
        logger,
        `Native Pi A2A peer failed to start: ${formatError(error)}`,
        { name: config.name },
      );
    }
  });

  pi.on("input", async (event: unknown) => {
    const text = extractEventText(event, "text");
    if (!text) {
      return { action: "continue" };
    }

    if (extractSource(event) === "extension") {
      markPrompt(turnRunner.extensionOriginPrompts, text);
      return { action: "continue" };
    }

    const directive = parseDispatchDirective(text);
    if (!directive) {
      return { action: "continue" };
    }

    try {
      const response = await dispatcher.dispatch(directive.agentName, directive.payload);
      await displayPiMessage(pi, logger, formatDirectReply(directive.agentName, response), {
        agentName: directive.agentName,
        mode: "dispatch",
      });
    } catch (error) {
      await displayPiMessage(
        pi,
        logger,
        `A2A dispatch to ${directive.agentName} failed: ${formatError(error)}`,
        { agentName: directive.agentName, mode: "dispatch" },
      );
    }

    return { action: "handled" };
  });

  pi.on("before_agent_start", async (event: unknown) => {
    const prompt = extractEventText(event, "prompt");
    if (!prompt) {
      return undefined;
    }

    if (consumePromptMark(turnRunner.extensionOriginPrompts, prompt)) {
      return undefined;
    }

    const mentions = parseAgentMentions(prompt);
    if (mentions.length === 0) {
      return undefined;
    }

    const seen = new Set<string>();
    const uniqueMentions = mentions.filter((m) => {
      if (seen.has(m.agentName)) return false;
      seen.add(m.agentName);
      return true;
    });
    const settled = await Promise.allSettled(
      uniqueMentions.map(async (mention) => {
        const peerPrompt = stripMention(prompt, mention).trim();
        return {
          agentName: mention.agentName,
          prompt: peerPrompt,
          response: await dispatcher.dispatch(mention.agentName, peerPrompt),
        };
      }),
    );
    const responses = settled.map((r, i) => {
      const mention = uniqueMentions[i];
      const peerPrompt = stripMention(prompt, mention).trim();
      return r.status === "fulfilled"
        ? r.value
        : {
            agentName: mention.agentName,
            prompt: peerPrompt,
            response: `Delegation failed: ${formatError(r.reason)}`,
          };
    });

    return {
      message: createPiMessage(formatDelegationContext(responses), {
        mode: "mention",
        agents: responses.map((response) => response.agentName),
      }),
    };
  });

  pi.on("session_shutdown", async () => {
    // Cancel the next re-advertise tick before closing the socket so a tick
    // can't race a closing server.
    heartbeat?.stop();
    heartbeat = null;
    if (!serverHandle) {
      return;
    }
    try {
      await serverHandle.stop();
    } finally {
      serverHandle = null;
    }
  });

  return {
    enabled: true,
    name: config.name,
    getUrl: () => serverHandle?.url ?? null,
    async stop() {
      heartbeat?.stop();
      heartbeat = null;
      if (serverHandle) {
        await serverHandle.stop();
        serverHandle = null;
      }
    },
  };
}
