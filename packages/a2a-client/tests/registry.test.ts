import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../src/registry.ts";

const VALID_AGENT_CARD = {
  name: "knowledge-compiler",
  description: "Compiles knowledge",
  supportedInterfaces: [
    {
      url: "http://localhost:55363",
      protocolBinding: "JSONRPC",
      tenant: "",
      protocolVersion: "0.2.1",
    },
  ],
  version: "1.0.0",
  capabilities: { extensions: [] },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  skills: [],
  signatures: [],
};

function createMockFetch(cardsByUrl: Record<string, unknown> = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = cardsByUrl[url];
    if (body) {
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "registry-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeConfig(agents: Record<string, { url: string }>): Promise<string> {
  const configPath = join(tmpDir, "registry.json");
  await writeFile(configPath, JSON.stringify({ agents }));
  return configPath;
}

describe("AgentRegistry", () => {
  describe("resolve", () => {
    test("resolves a known agent to a ResolvedAgentTarget", async () => {
      const configPath = await writeConfig({
        "knowledge-compiler": { url: "http://localhost:55363" },
      });
      const mockFetch = createMockFetch({
        "http://localhost:55363/.well-known/agent-card.json": VALID_AGENT_CARD,
      });
      const registry = new AgentRegistry({
        configPath,
        fetchImpl: mockFetch,
      });

      const result = await registry.resolve("knowledge-compiler");

      expect(result).not.toBeNull();
      expect(result?.baseUrl).toBe("http://localhost:55363");
      expect(result?.cardUrl).toBe("http://localhost:55363/.well-known/agent-card.json");
      expect(result?.card.name).toBe("knowledge-compiler");
      expect(result?.protocolVersion).toBe("0.2.1");
      expect(result?.capabilities.supportsTextInput).toBe(true);
      expect(result?.capabilities.supportsTextOutput).toBe(true);
    });

    test("returns null for an unknown agent", async () => {
      const configPath = await writeConfig({
        "knowledge-compiler": { url: "http://localhost:55363" },
      });
      const registry = new AgentRegistry({
        configPath,
        fetchImpl: createMockFetch(),
      });

      const result = await registry.resolve("nonexistent");

      expect(result).toBeNull();
    });

    test("throws when agent card fetch returns non-200", async () => {
      const configPath = await writeConfig({
        broken: { url: "http://localhost:9999" },
      });
      const registry = new AgentRegistry({
        configPath,
        fetchImpl: createMockFetch(),
      });

      await expect(registry.resolve("broken")).rejects.toThrow(/Failed to fetch agent card/);
    });

    test("throws when agent card is not a JSON object", async () => {
      // A2A 1.0: `validateAgentCard` wraps `AgentCard.fromJSON`, which is
      // lenient (fills proto defaults) for any object — the only hard rejection
      // is the non-object guard. A malformed object like `{ invalid: true }`
      // now resolves with defaults; a non-object body still throws.
      const configPath = await writeConfig({
        bad: { url: "http://localhost:55363" },
      });
      const mockFetch = createMockFetch({
        "http://localhost:55363/.well-known/agent-card.json": ["not-an-object"],
      });
      const registry = new AgentRegistry({
        configPath,
        fetchImpl: mockFetch,
      });

      await expect(registry.resolve("bad")).rejects.toThrow();
    });

    test("strips trailing slashes from base URL", async () => {
      const configPath = await writeConfig({
        slashy: { url: "http://localhost:55363/" },
      });
      const mockFetch = createMockFetch({
        "http://localhost:55363/.well-known/agent-card.json": VALID_AGENT_CARD,
      });
      const registry = new AgentRegistry({
        configPath,
        fetchImpl: mockFetch,
      });

      const result = await registry.resolve("slashy");

      expect(result).not.toBeNull();
      expect(result?.baseUrl).toBe("http://localhost:55363");
    });
  });

  describe("caching", () => {
    test("returns cached card on second resolve within TTL", async () => {
      const configPath = await writeConfig({
        cached: { url: "http://localhost:55363" },
      });
      let fetchCount = 0;
      const mockFetch = ((input: string | URL | Request) => {
        fetchCount++;
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("agent-card.json")) {
          return Promise.resolve(
            new Response(JSON.stringify(VALID_AGENT_CARD), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }) as typeof fetch;

      const registry = new AgentRegistry({
        configPath,
        cacheTtlMs: 60_000,
        fetchImpl: mockFetch,
      });

      const first = await registry.resolve("cached");
      const second = await registry.resolve("cached");

      expect(first).not.toBeNull();
      expect(second).toBe(first);
      expect(fetchCount).toBe(1);
    });

    test("re-fetches card after TTL expires", async () => {
      const configPath = await writeConfig({
        ttl: { url: "http://localhost:55363" },
      });
      let fetchCount = 0;
      const mockFetch = ((input: string | URL | Request) => {
        fetchCount++;
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("agent-card.json")) {
          return Promise.resolve(
            new Response(JSON.stringify(VALID_AGENT_CARD), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }) as typeof fetch;

      const registry = new AgentRegistry({
        configPath,
        cacheTtlMs: 0,
        fetchImpl: mockFetch,
      });

      await registry.resolve("ttl");
      await registry.resolve("ttl");

      expect(fetchCount).toBe(2);
    });
  });

  describe("list", () => {
    test("returns all registered agents (defaults to kind=a2a when kind is omitted)", async () => {
      const configPath = await writeConfig({
        "knowledge-compiler": { url: "http://localhost:55363" },
        "code-reviewer": { url: "http://localhost:55364" },
      });
      const registry = new AgentRegistry({
        configPath,
        fetchImpl: createMockFetch(),
      });

      const entries = await registry.list();

      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({
        kind: "a2a",
        name: "knowledge-compiler",
        url: "http://localhost:55363",
      });
      expect(entries[1]).toEqual({
        kind: "a2a",
        name: "code-reviewer",
        url: "http://localhost:55364",
      });
    });

    test("returns empty array when no agents are registered", async () => {
      const configPath = await writeConfig({});
      const registry = new AgentRegistry({
        configPath,
        fetchImpl: createMockFetch(),
      });

      const entries = await registry.list();

      expect(entries).toEqual([]);
    });

    test("returns ACP-kind entries with harness metadata", async () => {
      const configPath = join(tmpDir, "registry.json");
      await writeFile(
        configPath,
        JSON.stringify({
          agents: {
            "code-reviewer-acp": {
              kind: "acp",
              harness: "claude",
              command: "claude-agent-acp",
              args: ["--foo"],
              env: { CLAUDE_LOG_LEVEL: "debug" },
              workspaceFlag: "--cwd",
            },
            "a2a-peer": { kind: "a2a", url: "http://localhost:55363" },
          },
        }),
      );
      const registry = new AgentRegistry({
        configPath,
        fetchImpl: createMockFetch(),
      });

      const entries = await registry.list();
      expect(entries).toHaveLength(2);

      const acp = entries.find((e) => e.name === "code-reviewer-acp");
      expect(acp).toBeDefined();
      expect(acp?.kind).toBe("acp");
      if (acp?.kind === "acp") {
        expect(acp.harness).toBe("claude");
        expect(acp.command).toBe("claude-agent-acp");
        expect(acp.args).toEqual(["--foo"]);
        expect(acp.env).toEqual({ CLAUDE_LOG_LEVEL: "debug" });
        expect(acp.workspaceFlag).toBe("--cwd");
      }

      const a2a = entries.find((e) => e.name === "a2a-peer");
      expect(a2a?.kind).toBe("a2a");
    });
  });

  describe("resolve (kind-aware)", () => {
    test("returns null for ACP-kind entries even when the name matches", async () => {
      const configPath = join(tmpDir, "registry.json");
      await writeFile(
        configPath,
        JSON.stringify({
          agents: {
            "acp-agent": { kind: "acp", harness: "claude" },
          },
        }),
      );
      const registry = new AgentRegistry({
        configPath,
        fetchImpl: createMockFetch(),
      });

      const result = await registry.resolve("acp-agent");
      expect(result).toBeNull();
    });
  });

  describe("refresh", () => {
    test("clears cache and reloads config", async () => {
      const configPath = await writeConfig({
        agent1: { url: "http://localhost:55363" },
      });
      let fetchCount = 0;
      const mockFetch = ((input: string | URL | Request) => {
        fetchCount++;
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("agent-card.json")) {
          return Promise.resolve(
            new Response(JSON.stringify(VALID_AGENT_CARD), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }) as typeof fetch;

      const registry = new AgentRegistry({
        configPath,
        cacheTtlMs: 60_000,
        fetchImpl: mockFetch,
      });

      await registry.resolve("agent1");
      expect(fetchCount).toBe(1);

      registry.refresh();
      await registry.resolve("agent1");
      expect(fetchCount).toBe(2);
    });

    test("picks up config file changes after refresh", async () => {
      const configPath = await writeConfig({
        old: { url: "http://localhost:55363" },
      });
      const registry = new AgentRegistry({
        configPath,
        fetchImpl: createMockFetch(),
      });

      const before = await registry.list();
      expect(before).toHaveLength(1);
      expect(before[0]?.name).toBe("old");

      await writeFile(
        configPath,
        JSON.stringify({
          agents: {
            new1: { url: "http://localhost:55363" },
            new2: { url: "http://localhost:55364" },
          },
        }),
      );

      registry.refresh();
      const after = await registry.list();
      expect(after).toHaveLength(2);
      expect(after[0]?.name).toBe("new1");
    });
  });

  describe("config errors", () => {
    test("throws when config file does not exist", async () => {
      const registry = new AgentRegistry({
        configPath: join(tmpDir, "nonexistent.json"),
        fetchImpl: createMockFetch(),
      });

      await expect(registry.resolve("anything")).rejects.toThrow();
    });

    test("throws when config is invalid JSON", async () => {
      const configPath = join(tmpDir, "bad.json");
      await writeFile(configPath, "not json");
      const registry = new AgentRegistry({
        configPath,
        fetchImpl: createMockFetch(),
      });

      await expect(registry.resolve("anything")).rejects.toThrow();
    });

    test("throws when config is missing agents key", async () => {
      const configPath = join(tmpDir, "no-agents.json");
      await writeFile(configPath, JSON.stringify({ other: "stuff" }));
      const registry = new AgentRegistry({
        configPath,
        fetchImpl: createMockFetch(),
      });

      await expect(registry.resolve("anything")).rejects.toThrow(/Invalid registry config/);
    });

    test("throws when an ACP entry is missing its harness", async () => {
      const configPath = join(tmpDir, "bad-acp.json");
      await writeFile(configPath, JSON.stringify({ agents: { broken: { kind: "acp" } } }));
      const registry = new AgentRegistry({
        configPath,
        fetchImpl: createMockFetch(),
      });

      await expect(registry.resolve("broken")).rejects.toThrow(/harness/);
    });

    test("throws when an entry has an unknown kind", async () => {
      const configPath = join(tmpDir, "bad-kind.json");
      await writeFile(
        configPath,
        JSON.stringify({ agents: { broken: { kind: "mystery", url: "http://x" } } }),
      );
      const registry = new AgentRegistry({
        configPath,
        fetchImpl: createMockFetch(),
      });

      await expect(registry.resolve("broken")).rejects.toThrow(/unknown kind/);
    });
  });
});
