import { join } from "node:path";
import { type A2ALogger, createConsoleLogger } from "./logger.ts";

export class SessionIdStore {
  private filePath: string;
  private logger: A2ALogger;

  constructor(
    basePath: string = process.cwd(),
    logger: A2ALogger = createConsoleLogger("SessionIdStore"),
  ) {
    this.filePath = join(basePath, "_dot", "a2a-sessions.json");
    this.logger = logger;
  }

  /** Save the session map to disk */
  async save(map: Map<string, string>): Promise<void> {
    try {
      const data = Object.fromEntries(map);
      await Bun.write(this.filePath, JSON.stringify(data, null, 2));
    } catch (error) {
      this.logger.warn("Failed to save session file", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Load the session map from disk */
  async load(): Promise<Map<string, string>> {
    const file = Bun.file(this.filePath);
    if (!(await file.exists())) {
      return new Map();
    }
    try {
      const data = await file.json();
      return new Map(Object.entries(data));
    } catch {
      this.logger.warn("Failed to parse session file, starting fresh");
      return new Map();
    }
  }
}
