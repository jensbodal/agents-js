/**
 * Mock MCP bridge server for testing.
 *
 * Reads newline-delimited JSON-RPC from stdin, writes canned responses to stdout.
 * Simulates the `agents-js mcp` subprocess protocol.
 */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

const tools = [
  { name: "echo-agent", description: "Echoes messages back" },
  { name: "math-agent", description: "Does math" },
];

function handleRequest(req: JsonRpcRequest): JsonRpcResponse | null {
  // Notifications have no id — no response needed
  if (req.id == null) return null;

  switch (req.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mock-bridge", version: "1.0.0" },
        },
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: { tools },
      };

    case "tools/call": {
      const params = req.params as {
        name?: string;
        arguments?: { message?: string };
      };
      const message = params?.arguments?.message ?? "(empty)";
      const toolName = params?.name ?? "unknown";
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          content: [{ type: "text", text: `[${toolName}] ${message}` }],
        },
      };
    }

    default:
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
  }
}

// Main: read stdin line by line, process, write responses to stdout
const decoder = new TextDecoder();
let buffer = "";

const reader = Bun.stdin.stream().getReader();

async function run() {
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (line.length > 0) {
          try {
            const req = JSON.parse(line) as JsonRpcRequest;
            const response = handleRequest(req);
            if (response) {
              const out = `${JSON.stringify(response)}\n`;
              await Bun.write(Bun.stdout, out);
            }
          } catch {
            // Ignore parse errors
          }
        }

        newlineIdx = buffer.indexOf("\n");
      }
    }
  } catch {
    // stdin closed — exit cleanly
  }
}

run();
