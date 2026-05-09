import { type ACPProcessOptions, spawnACPAgent } from "@agents-js/acp";
import { buildAgentCard, type GatewayCardInput } from "./discovery.ts";
import { ACPtoA2AExecutor, type ExecutorHooks } from "./executor.ts";
import { UniversalA2AServer } from "./server.ts";

export interface A2AHttpServerHandle {
  port?: number;
  stop(closeActiveConnections?: boolean): void;
}

export interface ServeACPOverA2AOptions {
  /**
   * Spawn config for the ACP child. **Production callers MUST set
   * `acp.inheritedEnvKeys`** to a whitelist of env-var keys the child
   * is allowed to inherit from `process.env`; without it the child
   * sees the full parent env (and credentials for unrelated runtimes
   * leak in). The published `agents-js serve` command computes the
   * whitelist from the resolved runtime's `authEnvKeys`.
   */
  acp?: ACPProcessOptions;
  agentCard: GatewayCardInput;
  host?: string;
  /** Lifecycle hooks passed to the {@link ACPtoA2AExecutor}. */
  hooks?: ExecutorHooks;
  port?: number;
  /** Enable CORS headers on all responses (default: true). */
  cors?: boolean;
  /**
   * Optional pre-routing hook — same contract as
   * {@link UniversalA2AServerOptions.additionalFetch}. Return a `Response`
   * to handle the request before the A2A JSON-RPC path, or `null` to fall
   * through. Used by `agents-js serve` to mount the sync endpoint on the
   * same port as the A2A server.
   */
  additionalFetch?: (req: Request) => Promise<Response | null>;
}

export interface ServeACPOverA2AHandle {
  server: A2AHttpServerHandle;
  port: number;
  stop: () => void;
}

export async function serveACPOverA2A(
  options: ServeACPOverA2AOptions,
): Promise<ServeACPOverA2AHandle> {
  const acpProcess = spawnACPAgent(options.acp);

  try {
    const executor = new ACPtoA2AExecutor(acpProcess.stream, undefined, {
      hooks: options.hooks,
    });
    const serverWrapper = new UniversalA2AServer(
      executor,
      buildAgentCard(options.agentCard),
      undefined,
      {
        additionalFetch: options.additionalFetch,
      },
    );
    const server = await serverWrapper.start({
      hostname: options.host,
      port: options.port ?? 0,
      cors: options.cors ?? true,
    });

    const stop = () => {
      server.stop(true);
      acpProcess.kill();
    };

    return {
      server,
      port: server.port ?? options.port ?? 0,
      stop,
    };
  } catch (error) {
    acpProcess.kill();
    throw error;
  }
}
