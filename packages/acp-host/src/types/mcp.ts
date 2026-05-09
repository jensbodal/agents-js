/**
 * MCP protocol types for the local workspace MCP server.
 *
 * Covers JSON-RPC 2.0 request/response shapes and MCP tool definitions
 * needed for the HTTP transport. These are intentionally minimal --
 * only what the workspace MCP server uses, not the full MCP specification.
 */

// -- JSON-RPC 2.0 --

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Standard JSON-RPC error codes
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

// -- MCP Tool Definitions --

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
}

export interface McpToolInputSchema {
  type: "object";
  properties: Record<string, McpPropertySchema>;
  required?: string[];
}

export interface McpPropertySchema {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
}

// -- MCP Protocol Messages --

export interface McpToolsListResult {
  tools: McpToolDefinition[];
}

export interface McpToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: McpToolContent[];
  isError?: boolean;
}

export interface McpToolContent {
  type: "text";
  text: string;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: Record<string, never>;
  };
  serverInfo: {
    name: string;
    version: string;
  };
}
