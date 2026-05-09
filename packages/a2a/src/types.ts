export type { AgentCard, Message, Task, TaskStatus, TaskStatusUpdateEvent } from "@a2a-js/sdk";
export type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
export type {
  DiscoveredPrompt,
  DiscoveredResource,
  GatewayAgentCapabilities,
  GatewayAgentCard,
  GatewayCardInput,
} from "./discovery.ts";

import type { AgentExecutor } from "@a2a-js/sdk/server";
import type { InitializeResponse } from "@agents-js/acp";

/**
 * An AgentExecutor that also supports ACP initialization.
 *
 * Used by UniversalA2AServer to discover agent capabilities before
 * serving the A2A agent card. Both ACPtoA2AExecutor and HostA2AExecutor
 * implement this interface.
 */
export interface InitializableExecutor extends AgentExecutor {
  initialize(): Promise<InitializeResponse>;
}
