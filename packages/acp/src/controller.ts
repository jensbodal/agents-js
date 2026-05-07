import {
  type AgentCapabilities,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type AuthMethod,
  type CancelNotification,
  type Client,
  type ClientCapabilities,
  ClientSideConnection,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type CompleteElicitationNotification,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type ElicitationCapabilities,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type Implementation,
  type InitializeRequest,
  type InitializeResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type LogoutRequest,
  type LogoutResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  PROTOCOL_VERSION,
  type PromptRequest,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  RequestError,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type Stream,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { type ACPProcess, type ACPProcessOptions, spawnACPAgent } from "./connection.ts";
import { type ACPWorkspaceRootPolicy, resolveSessionCwd } from "./cwd-resolver.ts";

type TerminalAdapter = {
  create(params: CreateTerminalRequest): Promise<CreateTerminalResponse>;
  output(params: TerminalOutputRequest): Promise<TerminalOutputResponse>;
  waitForExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse>;
  kill(params: KillTerminalRequest): Promise<KillTerminalResponse | undefined>;
  release(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse | undefined>;
};

type ElicitationAdapter = {
  request(params: CreateElicitationRequest): Promise<CreateElicitationResponse>;
  complete?(params: CompleteElicitationNotification): Promise<void>;
  capabilities?: ElicitationCapabilities;
};

/**
 * Host platform callbacks injected into the ACP client controller at construction time.
 *
 * This is the primary **Adapter** interface in the Ports & Adapters architecture.
 * The controller delegates all host-specific decisions (permission prompts,
 * file I/O, terminal management, elicitation UI) to these callbacks rather
 * than implementing them directly. Each host platform (browser gateway,
 * desktop host, test harness) provides its own implementation.
 *
 * Only `requestPermission` and `sessionUpdate` are required. All other
 * adapters are optional -- the controller advertises available capabilities
 * to the agent based on which adapters are provided.
 *
 * @hostSurface
 */
export interface ACPHostAdapters {
  /** Handle a permission request from the agent. Return an approved/denied/cancelled outcome. */
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  /** Receive session update notifications (content blocks, status changes, plan updates). */
  sessionUpdate(params: SessionNotification): Promise<void>;
  /** Optional elicitation adapter for agent-driven form-based user input. */
  elicitation?: ElicitationAdapter;
  /** Optional file I/O adapters. Presence determines `fs` capability advertisement. */
  fs?: {
    readTextFile?(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
    writeTextFile?(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
  };
  /** Optional terminal lifecycle adapter. All five methods must be present for capability advertisement. */
  terminal?: Partial<TerminalAdapter>;
}

export type { ACPWorkspaceRootPolicy } from "./cwd-resolver.ts";

/**
 * State machine for the ACP client controller.
 *
 * Transitions follow this lifecycle:
 * ```
 * idle -> initializing -> ready -> starting_session -> session_ready
 *                                                        |       ^
 *                                                        v       |
 *                                                     prompting --+
 *                                                        |
 *                                                        v
 *                                                     cancelling -> session_ready
 *
 * Any state -> disposed (via dispose())
 * ```
 *
 * The `lastError` field is set whenever an operation fails. The `lastStopReason`
 * captures why the most recent prompt turn ended (e.g., "end_turn", "cancelled").
 *
 * @hostSurface
 */
export interface ACPClientState {
  /** Current lifecycle phase of the controller. */
  status:
    | "idle"
    | "initializing"
    | "ready"
    | "starting_session"
    | "session_ready"
    | "prompting"
    | "cancelling"
    | "disposed";
  /** Active session identifier, set after newSession() or loadSession(). */
  sessionId?: string;
  /** Agent implementation info returned during initialization. */
  agentInfo?: Implementation | null;
  /** Agent-advertised capabilities (modes, models, etc.). */
  agentCapabilities?: AgentCapabilities;
  /** Authentication methods the agent supports. */
  authMethods?: AuthMethod[];
  /** Stop reason from the most recent prompt response. */
  lastStopReason?: PromptResponse["stopReason"];
  /** Error from the most recent failed operation. */
  lastError?: unknown;
}

/** @hostSurface */
export type ACPControllerEvent =
  | { type: "state.updated"; state: ACPClientState }
  | { type: "initialized"; response: InitializeResponse }
  | { type: "authenticated"; response: AuthenticateResponse; request: AuthenticateRequest }
  | { type: "session.started"; response: NewSessionResponse; cwd: string }
  | {
      type: "session.loaded";
      response: LoadSessionResponse;
      sessionId: string;
      cwd: string;
    }
  | { type: "session.closed"; response: CloseSessionResponse }
  | {
      type: "session.forked";
      response: ForkSessionResponse;
      parentSessionId: string;
    }
  | { type: "session.resumed"; response: ResumeSessionResponse; sessionId: string }
  | {
      type: "session.config_option_set";
      response: SetSessionConfigOptionResponse;
      request: SetSessionConfigOptionRequest;
    }
  | { type: "logged_out"; response: LogoutResponse }
  | { type: "permission.requested"; request: RequestPermissionRequest }
  | { type: "elicitation.requested"; request: CreateElicitationRequest }
  | { type: "elicitation.completed"; notification: CompleteElicitationNotification }
  | { type: "session.updated"; notification: SessionNotification }
  | { type: "prompt.completed"; response: PromptResponse }
  | { type: "cancel.sent"; notification: CancelNotification }
  | { type: "disposed" }
  | { type: "error"; error: unknown };

type PendingPermissionRequest = {
  resolveCancelled(): void;
};

type ControllerTransport = {
  dispose(): void;
  stream: Stream;
};

export interface ACPClientControllerOptions {
  adapters: ACPHostAdapters;
  clientInfo?: InitializeRequest["clientInfo"];
  createProcess?: (options: ACPProcessOptions) => ACPProcess;
  dispose?: () => void;
  /** Timeout in ms for the ACP handshake (default: 30000) */
  handshakeTimeoutMs?: number;
  /** Optional structured logger for diagnostic tracing */
  log?: (message: string, data?: Record<string, unknown>) => void;
  processOptions?: ACPProcessOptions;
  stream?: Stream;
  workspacePolicy: ACPWorkspaceRootPolicy;
}

class ACPControllerError extends Error {
  readonly code:
    | "capability_not_supported"
    | "disposed"
    | "handshake_timeout"
    | "missing_active_session"
    | "missing_active_prompt"
    | "not_initialized"
    | "prompt_in_progress";

  constructor(code: ACPControllerError["code"], message: string) {
    super(message);
    this.name = "ACPControllerError";
    this.code = code;
  }
}

function hasFullTerminalAdapter(
  terminal: ACPHostAdapters["terminal"],
): terminal is TerminalAdapter {
  return Boolean(
    terminal?.create &&
      terminal.output &&
      terminal.waitForExit &&
      terminal.kill &&
      terminal.release,
  );
}

function buildClientCapabilities(adapters: ACPHostAdapters): ClientCapabilities | undefined {
  const fsReadTextFile = Boolean(adapters.fs?.readTextFile);
  const fsWriteTextFile = Boolean(adapters.fs?.writeTextFile);
  const terminal = hasFullTerminalAdapter(adapters.terminal);
  const elicitation =
    adapters.elicitation?.capabilities ?? (adapters.elicitation ? { form: {} } : undefined);

  if (!fsReadTextFile && !fsWriteTextFile && !terminal && !elicitation) {
    return undefined;
  }

  return {
    ...(fsReadTextFile || fsWriteTextFile
      ? {
          fs: {
            readTextFile: fsReadTextFile,
            writeTextFile: fsWriteTextFile,
          },
        }
      : {}),
    ...(terminal ? { terminal: true } : {}),
    ...(elicitation ? { elicitation } : {}),
  };
}

function createTransport(options: ACPClientControllerOptions): ControllerTransport {
  if (options.stream) {
    return {
      stream: options.stream,
      dispose: () => options.dispose?.(),
    };
  }

  const createProcess = options.createProcess ?? spawnACPAgent;
  const process = createProcess(options.processOptions ?? {});

  return {
    stream: process.stream,
    dispose: () => process.kill(),
  };
}

/**
 * Low-level ACP client controller managing the full agent lifecycle.
 *
 * This is the **Provider** for ACP communication. It owns the connection state
 * machine, sends protocol messages over a stdio/NDJSON transport, and delegates
 * host-platform decisions to the injected {@link ACPHostAdapters}.
 *
 * Lifecycle: construct -> initialize() -> newSession()/loadSession() -> prompt() -> dispose()
 *
 * Subscribe to events via {@link subscribe} to track state changes, permissions,
 * elicitation requests, and prompt completions.
 *
 * @example
 * ```ts ignore
 * const controller = new ACPClientController({ adapters, processOptions, workspacePolicy });
 * controller.subscribe((event, state) => console.log(event.type, state.status));
 * await controller.initialize();
 * await controller.newSession();
 * const response = await controller.prompt({ message: "Hello" });
 * controller.dispose();
 * ```
 *
 * @hostSurface
 */
export class ACPClientController {
  private readonly adapters: ACPHostAdapters;
  private readonly clientInfo?: InitializeRequest["clientInfo"];
  private readonly connection: ClientSideConnection;
  private readonly handshakeTimeoutMs: number;
  private readonly listeners = new Set<
    (event: ACPControllerEvent, state: ACPClientState) => void
  >();
  private readonly log?: (message: string, data?: Record<string, unknown>) => void;
  private readonly pendingPermissions = new Set<PendingPermissionRequest>();
  private readonly transport: ControllerTransport;
  private readonly workspacePolicy: ACPWorkspaceRootPolicy;
  private initializedResponse?: InitializeResponse;
  private promptInFlight = false;
  private state: ACPClientState = { status: "idle" };

  constructor(options: ACPClientControllerOptions) {
    this.adapters = options.adapters;
    this.clientInfo = options.clientInfo;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 30_000;
    this.log = options.log;
    this.transport = createTransport(options);
    this.workspacePolicy = options.workspacePolicy;
    this.connection = new ClientSideConnection(
      () => this.createClientHandlers(),
      this.transport.stream,
    );
  }

  /**
   * Subscribe to controller events. Returns an unsubscribe function.
   * Listeners receive every event (state changes, protocol events, errors)
   * along with the current state snapshot at the time of the event.
   */
  subscribe(listener: (event: ACPControllerEvent, state: ACPClientState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Return the current state snapshot. */
  getState(): ACPClientState {
    return this.state;
  }

  /**
   * Initialize the ACP handshake with the agent process.
   * Advertises client capabilities based on the provided adapters.
   * Must be called before any session or prompt operations.
   * @throws {ACPControllerError} If already disposed or handshake times out.
   * @hostLifecycle
   */
  async initialize(
    request: Omit<InitializeRequest, "clientCapabilities" | "protocolVersion"> = {},
  ): Promise<InitializeResponse> {
    this.assertNotDisposed();
    if (this.initializedResponse) {
      return this.initializedResponse;
    }

    this.transitionTo("initializing");

    try {
      const initPromise = this.connection.initialize({
        ...request,
        clientCapabilities: buildClientCapabilities(this.adapters),
        clientInfo: request.clientInfo ?? this.clientInfo,
        protocolVersion: PROTOCOL_VERSION,
      });

      let timeoutId: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new ACPControllerError(
              "handshake_timeout",
              `ACP handshake did not complete within ${this.handshakeTimeoutMs}ms`,
            ),
          );
        }, this.handshakeTimeoutMs);
      });

      let response: InitializeResponse;
      try {
        response = await Promise.race([initPromise, timeoutPromise]);
      } catch (error) {
        if (error instanceof ACPControllerError && error.code === "handshake_timeout") {
          this.transport.dispose();
        }
        throw error;
      } finally {
        // biome-ignore lint/style/noNonNullAssertion: timeoutId is always assigned before this finally block
        clearTimeout(timeoutId!);
      }

      this.initializedResponse = response;
      this.setState({
        ...this.state,
        status: this.state.sessionId ? "session_ready" : "ready",
        agentInfo: response.agentInfo,
        agentCapabilities: response.agentCapabilities,
        authMethods: response.authMethods,
        lastError: undefined,
      });
      this.notify({ type: "initialized", response });
      return response;
    } catch (error) {
      this.recordError(error, "idle");
      throw error;
    }
  }

  /**
   * Create a new agent session. Resolves the working directory from the
   * workspace policy and sends the session creation request.
   * @throws {ACPControllerError} If not initialized or a prompt is in progress.
   * @hostLifecycle
   */
  async newSession(
    request: Omit<NewSessionRequest, "cwd" | "mcpServers"> & {
      cwd?: string;
      mcpServers?: NewSessionRequest["mcpServers"];
    } = {},
  ): Promise<NewSessionResponse> {
    this.assertInitialized();
    this.assertPromptIsIdle();
    this.transitionTo("starting_session");

    try {
      const cwd = await resolveSessionCwd(request.cwd, this.workspacePolicy);
      const response = await this.connection.newSession({
        ...request,
        cwd,
        mcpServers: request.mcpServers ?? [],
      });

      this.setState({
        ...this.state,
        status: "session_ready",
        sessionId: response.sessionId,
        lastError: undefined,
      });
      this.notify({ type: "session.started", response, cwd });
      return response;
    } catch (error) {
      this.recordError(error, this.state.sessionId ? "session_ready" : "ready");
      throw error;
    }
  }

  async listSessions(request: ListSessionsRequest = {}): Promise<ListSessionsResponse> {
    this.assertInitialized();
    return this.connection.listSessions(request);
  }

  /**
   * Resume a previously-created agent session by id. Resolves the working
   * directory from the workspace policy and forwards the load request to
   * the agent.
   *
   * @hostLifecycle
   */
  async loadSession(request: {
    sessionId: string;
    cwd?: string;
    mcpServers?: LoadSessionRequest["mcpServers"];
  }): Promise<LoadSessionResponse> {
    this.assertInitialized();
    this.assertPromptIsIdle();
    this.cancelPendingPermissionRequests();
    this.transitionTo("starting_session");

    try {
      const cwd = await resolveSessionCwd(request.cwd, this.workspacePolicy);
      const response = await this.connection.loadSession({
        sessionId: request.sessionId,
        cwd,
        mcpServers: request.mcpServers ?? [],
      });

      this.setState({
        ...this.state,
        status: "session_ready",
        sessionId: request.sessionId,
        lastError: undefined,
      });
      this.notify({
        type: "session.loaded",
        response,
        sessionId: request.sessionId,
        cwd,
      });
      return response;
    } catch (error) {
      this.recordError(error, this.state.sessionId ? "session_ready" : "ready");
      throw error;
    }
  }

  /**
   * Close the active session gracefully.
   * Sends a `session/close` request to the agent, clears the session ID,
   * and transitions state to `ready`.
   * @throws {ACPControllerError} If not initialized, disposed, capability not advertised, or no active session.
   */
  async closeSession(
    request: Omit<CloseSessionRequest, "sessionId"> = {},
  ): Promise<CloseSessionResponse> {
    this.assertInitialized();
    this.assertPromptIsIdle();
    this.assertCapability(
      this.state.agentCapabilities?.sessionCapabilities?.close != null,
      "session/close",
    );
    const sessionId = this.requireSessionId();

    try {
      const response = await this.connection.closeSession({
        ...request,
        sessionId,
      });

      this.setState({
        ...this.state,
        status: "ready",
        sessionId: undefined,
        lastError: undefined,
      });
      this.notify({ type: "session.closed", response });
      return response;
    } catch (error) {
      this.recordError(error, this.state.sessionId ? "session_ready" : "ready");
      throw error;
    }
  }

  /**
   * Fork the active session, creating a new branched session with shared history.
   * Sends a `session/fork` request to the agent, then updates the session ID
   * to the forked session's ID and transitions state to `session_ready`.
   * @throws {ACPControllerError} If not initialized, disposed, prompt in progress, capability not advertised, or no active session.
   */
  async forkSession(
    request: Omit<ForkSessionRequest, "sessionId" | "cwd" | "mcpServers"> & {
      cwd?: string;
      mcpServers?: ForkSessionRequest["mcpServers"];
    } = {},
  ): Promise<ForkSessionResponse> {
    this.assertInitialized();
    this.assertPromptIsIdle();
    this.assertCapability(
      this.state.agentCapabilities?.sessionCapabilities?.fork != null,
      "session/fork",
    );
    const sessionId = this.requireSessionId();

    try {
      const cwd = await resolveSessionCwd(request.cwd, this.workspacePolicy);
      const response = await this.connection.unstable_forkSession({
        ...request,
        sessionId,
        cwd,
        mcpServers: request.mcpServers ?? [],
      });

      this.setState({
        ...this.state,
        status: "session_ready",
        sessionId: response.sessionId,
        lastError: undefined,
      });
      this.notify({
        type: "session.forked",
        response,
        parentSessionId: sessionId,
      });
      return response;
    } catch (error) {
      this.recordError(error, "session_ready");
      throw error;
    }
  }

  /**
   * Resume a previously closed session by its ID.
   * Sends a `session/resume` request to the agent, then sets the session ID
   * and transitions state to `session_ready`.
   * @throws {ACPControllerError} If not initialized, disposed, prompt in progress, or capability not advertised.
   */
  async resumeSession(
    request: Omit<ResumeSessionRequest, "cwd" | "mcpServers"> & {
      cwd?: string;
      mcpServers?: ResumeSessionRequest["mcpServers"];
    },
  ): Promise<ResumeSessionResponse> {
    this.assertInitialized();
    this.assertPromptIsIdle();
    this.assertCapability(
      this.state.agentCapabilities?.sessionCapabilities?.resume != null,
      "session/resume",
    );

    try {
      const cwd = await resolveSessionCwd(request.cwd, this.workspacePolicy);
      const response = await this.connection.resumeSession({
        ...request,
        cwd,
        mcpServers: request.mcpServers ?? [],
      });

      this.setState({
        ...this.state,
        status: "session_ready",
        sessionId: request.sessionId,
        lastError: undefined,
      });
      this.notify({
        type: "session.resumed",
        response,
        sessionId: request.sessionId,
      });
      return response;
    } catch (error) {
      this.recordError(error, this.state.sessionId ? "session_ready" : "ready");
      throw error;
    }
  }

  /**
   * Set a session configuration option on the server.
   * Sends a `session/set_config_option` request with the given parameters.
   * This is a fire-and-forget config update that does not transition state.
   * @throws {ACPControllerError} If not initialized, disposed, or no active session.
   */
  async setConfigOption(
    request: Omit<SetSessionConfigOptionRequest, "sessionId">,
  ): Promise<SetSessionConfigOptionResponse> {
    this.assertInitialized();
    const sessionId = this.requireSessionId();

    try {
      const fullRequest: SetSessionConfigOptionRequest = {
        ...request,
        sessionId,
      } as SetSessionConfigOptionRequest;
      const response = await this.connection.setSessionConfigOption(fullRequest);
      this.notify({
        type: "session.config_option_set",
        response,
        request: fullRequest,
      });
      return response;
    } catch (error) {
      this.recordError(error, "session_ready");
      throw error;
    }
  }

  /**
   * Log out from the current authenticated state.
   * Sends a `logout` request to the agent, clears auth methods from state,
   * and transitions to `ready`.
   * @throws {ACPControllerError} If not initialized or disposed.
   */
  async logout(request: Omit<LogoutRequest, never> = {}): Promise<LogoutResponse> {
    this.assertInitialized();
    this.assertNotDisposed();

    try {
      const response = await this.connection.unstable_logout(request);
      this.setState({
        ...this.state,
        authMethods: undefined,
        status: this.state.sessionId ? "session_ready" : "ready",
        lastError: undefined,
      });
      this.notify({ type: "logged_out", response });
      return response;
    } catch (error) {
      this.recordError(error, this.state.sessionId ? "session_ready" : "ready");
      throw error;
    }
  }

  /**
   * Send a prompt turn to the agent in the active session.
   * Only one prompt can be in-flight at a time. While the prompt is active,
   * the agent may call back through the adapters (permissions, file I/O, etc.).
   * @throws {ACPControllerError} If no active session or a prompt is already in progress.
   * @hostLifecycle
   */
  async prompt(request: Omit<PromptRequest, "sessionId">): Promise<PromptResponse> {
    this.assertInitialized();
    this.assertPromptIsIdle();
    const sessionId = this.requireSessionId();

    this.promptInFlight = true;
    this.transitionTo("prompting");

    try {
      const response = await this.connection.prompt({
        ...request,
        sessionId,
      });
      this.setState({
        ...this.state,
        lastError: undefined,
        lastStopReason: response.stopReason,
        status: "session_ready",
      });
      this.notify({ type: "prompt.completed", response });
      return response;
    } catch (error) {
      this.recordError(error, "session_ready");
      throw error;
    } finally {
      this.promptInFlight = false;
    }
  }

  async authenticate(request: AuthenticateRequest): Promise<AuthenticateResponse> {
    this.assertInitialized();
    this.assertNotDisposed();

    try {
      const response = (await this.connection.authenticate(request)) ?? {};
      this.transitionTo(this.state.sessionId ? "session_ready" : "ready");
      this.notify({ type: "authenticated", response, request });
      return response;
    } catch (error) {
      this.recordError(error, this.state.sessionId ? "session_ready" : "ready");
      throw error;
    }
  }

  /**
   * Emergency escape hatch: forcibly clear the promptInFlight flag.
   *
   * This is intended for use by the session controller's forceReset() method
   * when a prompt has timed out and the controller needs to recover.
   * Normal callers should use cancel() instead.
   */
  _forceResetPromptInFlight(): void {
    this.promptInFlight = false;
  }

  /**
   * Cancel the currently in-flight prompt turn. Also cancels any pending
   * permission requests that are waiting for host approval.
   * @throws {ACPControllerError} If no prompt is currently active.
   * @hostLifecycle
   */
  async cancel(notification: Omit<CancelNotification, "sessionId"> = {}): Promise<void> {
    this.assertInitialized();
    const sessionId = this.requireSessionId();
    if (!this.promptInFlight) {
      throw new ACPControllerError(
        "missing_active_prompt",
        "Cannot cancel because there is no active prompt turn.",
      );
    }

    this.transitionTo("cancelling");
    this.cancelPendingPermissionRequests();

    try {
      const payload = {
        ...notification,
        sessionId,
      };
      await this.connection.cancel(payload);
      this.notify({ type: "cancel.sent", notification: payload });
    } catch (error) {
      this.recordError(error, "session_ready");
      throw error;
    }
  }

  async setMode(modeId: string): Promise<void> {
    this.assertInitialized();
    const sessionId = this.requireSessionId();
    await this.connection.setSessionMode({ sessionId, modeId });
  }

  /** @experimental -- models API is not part of the stable ACP spec */
  async setModel(modelId: string): Promise<void> {
    this.assertInitialized();
    const sessionId = this.requireSessionId();
    await this.connection.unstable_setSessionModel({ sessionId, modelId });
  }

  /**
   * Dispose the controller, killing the agent process and cleaning up resources.
   * Cancels any pending permission requests. Idempotent -- safe to call multiple times.
   * @hostLifecycle
   */
  dispose(): void {
    if (this.state.status === "disposed") {
      return;
    }

    this.cancelPendingPermissionRequests();
    this.transport.dispose();
    this.setState({
      ...this.state,
      status: "disposed",
    });
    this.notify({ type: "disposed" });
  }

  private assertInitialized(): void {
    this.assertNotDisposed();
    if (!this.initializedResponse) {
      throw new ACPControllerError(
        "not_initialized",
        "Call initialize() before using session APIs.",
      );
    }
  }

  private assertNotDisposed(): void {
    if (this.state.status === "disposed") {
      throw new ACPControllerError(
        "disposed",
        "This ACP client controller has already been disposed.",
      );
    }
  }

  private assertPromptIsIdle(): void {
    if (this.promptInFlight) {
      throw new ACPControllerError(
        "prompt_in_progress",
        "Cannot start another operation while a prompt turn is still active.",
      );
    }
  }

  private assertCapability(supported: boolean, method: string): void {
    if (!supported) {
      throw new ACPControllerError(
        "capability_not_supported",
        `Agent does not support ${method}. Check agentCapabilities before calling this method.`,
      );
    }
  }

  private requireSessionId(): string {
    const sessionId = this.state.sessionId;
    if (!sessionId) {
      throw new ACPControllerError("missing_active_session", "No active session.");
    }
    return sessionId;
  }

  private cancelPendingPermissionRequests(): void {
    for (const pendingPermission of [...this.pendingPermissions]) {
      pendingPermission.resolveCancelled();
    }
  }

  private createClientHandlers(): Client {
    const handlers: Client = {
      requestPermission: async (params) => {
        this.log?.("Permission request received at protocol boundary", {
          toolCallId: params.toolCall?.toolCallId,
          title: params.toolCall?.title,
          kind: params.toolCall?.kind,
          optionCount: params.options?.length,
        });
        this.notify({ type: "permission.requested", request: params });
        const cancelledResponse: RequestPermissionResponse = {
          outcome: {
            outcome: "cancelled",
          },
        };

        return await new Promise<RequestPermissionResponse>((resolve, reject) => {
          const pendingPermission: PendingPermissionRequest = {
            resolveCancelled: () => {
              if (!this.pendingPermissions.delete(pendingPermission)) {
                return;
              }
              resolve(cancelledResponse);
            },
          };

          this.pendingPermissions.add(pendingPermission);

          void this.adapters.requestPermission(params).then(
            (response) => {
              if (!this.pendingPermissions.delete(pendingPermission)) {
                return;
              }
              resolve(response);
            },
            (error) => {
              if (!this.pendingPermissions.delete(pendingPermission)) {
                return;
              }
              reject(error);
            },
          );
        });
      },
      sessionUpdate: async (params) => {
        this.notify({ type: "session.updated", notification: params });
        await this.adapters.sessionUpdate(params);
      },
      extMethod: async (method, _params) => {
        throw RequestError.methodNotFound(method);
      },
      extNotification: async (_method, _params) => {},
    };

    if (this.adapters.elicitation) {
      const elicitationAdapter = this.adapters.elicitation;
      handlers.unstable_createElicitation = async (request) => {
        this.notify({ type: "elicitation.requested", request });
        return await elicitationAdapter.request(request);
      };
      if (elicitationAdapter.complete) {
        const completeFn = elicitationAdapter.complete;
        handlers.unstable_completeElicitation = async (notification) => {
          this.notify({ type: "elicitation.completed", notification });
          await completeFn(notification);
        };
      }
    }

    if (this.adapters.fs?.readTextFile) {
      handlers.readTextFile = this.adapters.fs.readTextFile;
    }

    if (this.adapters.fs?.writeTextFile) {
      handlers.writeTextFile = this.adapters.fs.writeTextFile;
    }

    if (hasFullTerminalAdapter(this.adapters.terminal)) {
      handlers.createTerminal = this.adapters.terminal.create;
      handlers.terminalOutput = this.adapters.terminal.output;
      handlers.waitForTerminalExit = this.adapters.terminal.waitForExit;
      handlers.killTerminal = this.adapters.terminal.kill;
      handlers.releaseTerminal = this.adapters.terminal.release;
    }

    return handlers;
  }

  private notify(event: ACPControllerEvent): void {
    if (event.type !== "state.updated") {
      for (const listener of this.listeners) {
        listener(event, this.state);
      }
    }
  }

  private recordError(error: unknown, status: ACPClientState["status"]): void {
    this.setState({
      ...this.state,
      lastError: error,
      status,
    });
    this.notify({ type: "error", error });
  }

  private setState(nextState: ACPClientState): void {
    this.state = nextState;
    const event: ACPControllerEvent = {
      type: "state.updated",
      state: this.state,
    };
    for (const listener of this.listeners) {
      listener(event, this.state);
    }
  }

  private transitionTo(status: ACPClientState["status"]): void {
    this.setState({ ...this.state, status, lastError: undefined });
  }
}
