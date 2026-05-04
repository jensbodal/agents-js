import type { ACPMethod } from "../src/index.ts";

const implementation = {
  name: "agents-js",
  version: "1.0.0",
};

const sessionMode = {
  id: "code",
  name: "Code",
};

const sessionModeState = {
  currentModeId: "code",
  availableModes: [sessionMode],
};

const sessionConfigOption = {
  type: "select",
  id: "model",
  name: "Model",
  currentValue: "gpt-5",
  options: [{ value: "gpt-5", name: "GPT-5" }],
};

const sessionModelState = {
  currentModelId: "gpt-5",
  availableModels: [{ modelId: "gpt-5", name: "GPT-5" }],
};

const mcpServer = {
  name: "filesystem",
  command: "npx",
  args: ["@modelcontextprotocol/server-filesystem", "/tmp"],
  env: [],
};

export const validACPRequestCases: Array<{ envelope: unknown; method: ACPMethod }> = [
  {
    method: "authenticate",
    envelope: {
      jsonrpc: "2.0",
      id: 1,
      method: "authenticate",
      params: { methodId: "agent" },
    },
  },
  {
    method: "fs/read_text_file",
    envelope: {
      jsonrpc: "2.0",
      id: 2,
      method: "fs/read_text_file",
      params: { sessionId: "session-1", path: "/tmp/file.txt" },
    },
  },
  {
    method: "fs/write_text_file",
    envelope: {
      jsonrpc: "2.0",
      id: 3,
      method: "fs/write_text_file",
      params: { sessionId: "session-1", path: "/tmp/file.txt", content: "hello" },
    },
  },
  {
    method: "initialize",
    envelope: {
      jsonrpc: "2.0",
      id: 4,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientInfo: implementation,
        clientCapabilities: {
          auth: { terminal: true },
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      },
    },
  },
  {
    method: "session/cancel",
    envelope: {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "session-1" },
    },
  },
  {
    method: "session/close",
    envelope: {
      jsonrpc: "2.0",
      id: 5,
      method: "session/close",
      params: { sessionId: "session-1" },
    },
  },
  {
    method: "session/fork",
    envelope: {
      jsonrpc: "2.0",
      id: 6,
      method: "session/fork",
      params: { sessionId: "session-1", cwd: "/tmp" },
    },
  },
  {
    method: "session/list",
    envelope: {
      jsonrpc: "2.0",
      id: 7,
      method: "session/list",
      params: {},
    },
  },
  {
    method: "session/load",
    envelope: {
      jsonrpc: "2.0",
      id: 8,
      method: "session/load",
      params: { sessionId: "session-1", cwd: "/tmp", mcpServers: [mcpServer] },
    },
  },
  {
    method: "session/new",
    envelope: {
      jsonrpc: "2.0",
      id: 9,
      method: "session/new",
      params: { cwd: "/tmp", mcpServers: [mcpServer] },
    },
  },
  {
    method: "session/prompt",
    envelope: {
      jsonrpc: "2.0",
      id: 10,
      method: "session/prompt",
      params: {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "Hello ACP" }],
        messageId: "msg-1",
      },
    },
  },
  {
    method: "session/request_permission",
    envelope: {
      jsonrpc: "2.0",
      id: 11,
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        toolCall: { toolCallId: "tool-1" },
        options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
      },
    },
  },
  {
    method: "session/resume",
    envelope: {
      jsonrpc: "2.0",
      id: 12,
      method: "session/resume",
      params: { sessionId: "session-1", cwd: "/tmp" },
    },
  },
  {
    method: "session/set_config_option",
    envelope: {
      jsonrpc: "2.0",
      id: 13,
      method: "session/set_config_option",
      params: { sessionId: "session-1", configId: "model", value: "gpt-5" },
    },
  },
  {
    method: "session/set_mode",
    envelope: {
      jsonrpc: "2.0",
      id: 14,
      method: "session/set_mode",
      params: { sessionId: "session-1", modeId: "code" },
    },
  },
  {
    method: "session/set_model",
    envelope: {
      jsonrpc: "2.0",
      id: 15,
      method: "session/set_model",
      params: { sessionId: "session-1", modelId: "gpt-5" },
    },
  },
  {
    method: "session/update",
    envelope: {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: "code",
        },
      },
    },
  },
  {
    method: "terminal/create",
    envelope: {
      jsonrpc: "2.0",
      id: 16,
      method: "terminal/create",
      params: { sessionId: "session-1", command: "echo" },
    },
  },
  {
    method: "terminal/kill",
    envelope: {
      jsonrpc: "2.0",
      id: 17,
      method: "terminal/kill",
      params: { sessionId: "session-1", terminalId: "terminal-1" },
    },
  },
  {
    method: "terminal/output",
    envelope: {
      jsonrpc: "2.0",
      id: 18,
      method: "terminal/output",
      params: { sessionId: "session-1", terminalId: "terminal-1" },
    },
  },
  {
    method: "terminal/release",
    envelope: {
      jsonrpc: "2.0",
      id: 19,
      method: "terminal/release",
      params: { sessionId: "session-1", terminalId: "terminal-1" },
    },
  },
  {
    method: "terminal/wait_for_exit",
    envelope: {
      jsonrpc: "2.0",
      id: 20,
      method: "terminal/wait_for_exit",
      params: { sessionId: "session-1", terminalId: "terminal-1" },
    },
  },
];

export const validACPResponseCases: Array<{ envelope: unknown; method: ACPMethod }> = [
  {
    method: "authenticate",
    envelope: {
      jsonrpc: "2.0",
      id: 1,
      result: {},
    },
  },
  {
    method: "fs/read_text_file",
    envelope: {
      jsonrpc: "2.0",
      id: 2,
      result: { content: "hello" },
    },
  },
  {
    method: "fs/write_text_file",
    envelope: {
      jsonrpc: "2.0",
      id: 3,
      result: {},
    },
  },
  {
    method: "initialize",
    envelope: {
      jsonrpc: "2.0",
      id: 4,
      result: {
        protocolVersion: 1,
        agentInfo: implementation,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: false, sse: false },
          promptCapabilities: { image: true },
          sessionCapabilities: {
            close: {},
            fork: {},
            list: {},
            resume: {},
          },
        },
        authMethods: [{ id: "agent", name: "Agent auth" }],
      },
    },
  },
  {
    method: "session/close",
    envelope: {
      jsonrpc: "2.0",
      id: 5,
      result: {},
    },
  },
  {
    method: "session/fork",
    envelope: {
      jsonrpc: "2.0",
      id: 6,
      result: { sessionId: "session-2" },
    },
  },
  {
    method: "session/list",
    envelope: {
      jsonrpc: "2.0",
      id: 7,
      result: { sessions: [{ sessionId: "session-1", cwd: "/tmp" }] },
    },
  },
  {
    method: "session/load",
    envelope: {
      jsonrpc: "2.0",
      id: 8,
      result: {
        configOptions: [sessionConfigOption],
        modes: sessionModeState,
        models: sessionModelState,
      },
    },
  },
  {
    method: "session/new",
    envelope: {
      jsonrpc: "2.0",
      id: 9,
      result: { sessionId: "session-1" },
    },
  },
  {
    method: "session/prompt",
    envelope: {
      jsonrpc: "2.0",
      id: 10,
      result: {
        stopReason: "end_turn",
        userMessageId: "msg-1",
        usage: {
          totalTokens: 10,
          inputTokens: 5,
          outputTokens: 5,
        },
      },
    },
  },
  {
    method: "session/request_permission",
    envelope: {
      jsonrpc: "2.0",
      id: 11,
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    },
  },
  {
    method: "session/resume",
    envelope: {
      jsonrpc: "2.0",
      id: 12,
      result: {
        configOptions: [sessionConfigOption],
        modes: sessionModeState,
        models: sessionModelState,
      },
    },
  },
  {
    method: "session/set_config_option",
    envelope: {
      jsonrpc: "2.0",
      id: 13,
      result: { configOptions: [sessionConfigOption] },
    },
  },
  {
    method: "session/set_mode",
    envelope: {
      jsonrpc: "2.0",
      id: 14,
      result: {},
    },
  },
  {
    method: "session/set_model",
    envelope: {
      jsonrpc: "2.0",
      id: 15,
      result: {},
    },
  },
  {
    method: "terminal/create",
    envelope: {
      jsonrpc: "2.0",
      id: 16,
      result: { terminalId: "terminal-1" },
    },
  },
  {
    method: "terminal/kill",
    envelope: {
      jsonrpc: "2.0",
      id: 17,
      result: {},
    },
  },
  {
    method: "terminal/output",
    envelope: {
      jsonrpc: "2.0",
      id: 18,
      result: {
        output: "hello",
        truncated: false,
        exitStatus: {
          exitCode: 0,
          signal: null,
        },
      },
    },
  },
  {
    method: "terminal/release",
    envelope: {
      jsonrpc: "2.0",
      id: 19,
      result: {},
    },
  },
  {
    method: "terminal/wait_for_exit",
    envelope: {
      jsonrpc: "2.0",
      id: 20,
      result: {
        exitCode: 0,
        signal: null,
      },
    },
  },
];
