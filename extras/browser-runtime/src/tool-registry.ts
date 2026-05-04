export type ToolName = "searchDocs" | "readCodeSnippet";

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface LocalToolRegistry {
  invoke(name: ToolName, args: Record<string, unknown>): Promise<unknown>;
  names(): ToolName[];
}

export function createToolRegistry(handlers: Record<ToolName, ToolHandler>): LocalToolRegistry {
  return {
    async invoke(name, args) {
      const handler = handlers[name];
      if (!handler) throw new Error(`unknown tool: ${name}`);
      return handler(args);
    },
    names() {
      return Object.keys(handlers) as ToolName[];
    },
  };
}
