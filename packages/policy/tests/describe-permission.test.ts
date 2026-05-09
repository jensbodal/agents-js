import { describe, expect, test } from "bun:test";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import {
  describeOperationClass,
  describeReplayScope,
  KNOWN_OPERATION_CLASSES,
} from "../src/describe-permission.ts";

function makeRequest(
  toolName: string | null,
  args?: Record<string, unknown>,
): RequestPermissionRequest {
  const toolCall =
    toolName === null ? undefined : { toolCallId: "tc-1", title: toolName, rawInput: args };
  return {
    sessionId: "test-session",
    toolCall,
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
  } as RequestPermissionRequest;
}

describe("describeOperationClass", () => {
  // Pins every known operation class. Adding a branch to classifyOperation
  // requires extending KNOWN_OPERATION_CLASSES; adding to that array requires
  // extending the switch in describeOperationClass (enforced at type-check).
  // This loop then fails if the new class is covered by the switch but returns
  // an empty or fallback-identical string.
  const fallbackWithoutTitle = "run this tool request";

  for (const operationClass of KNOWN_OPERATION_CLASSES) {
    test(`returns a non-fallback description for ${operationClass}`, () => {
      const description = describeOperationClass(operationClass, makeRequest("some-tool"));
      expect(description).not.toBe(fallbackWithoutTitle);
      expect(description.length).toBeGreaterThan(0);
    });
  }

  test("every known class produces a unique description", () => {
    const seen = new Map<string, string>();
    for (const operationClass of KNOWN_OPERATION_CLASSES) {
      const description = describeOperationClass(operationClass, makeRequest("t"));
      const prior = seen.get(description);
      expect(prior).toBeUndefined();
      seen.set(description, operationClass);
    }
  });

  test("stable copy for each known class", () => {
    expect(describeOperationClass("file.read", makeRequest("t"))).toBe("read this file");
    expect(describeOperationClass("file.write", makeRequest("t"))).toBe("write this file");
    expect(describeOperationClass("file.delete", makeRequest("t"))).toBe("delete this file");
    expect(describeOperationClass("terminal.create", makeRequest("t"))).toBe("run this command");
    expect(describeOperationClass("workspace.search", makeRequest("t"))).toBe(
      "run this workspace search",
    );
    expect(describeOperationClass("workspace.command.execute", makeRequest("t"))).toBe(
      "run this workspace command",
    );
    expect(describeOperationClass("workspace.command.list", makeRequest("t"))).toBe(
      "list workspace commands",
    );
    expect(describeOperationClass("workspace.data-query", makeRequest("t"))).toBe(
      "run this data query",
    );
    expect(describeOperationClass("workspace.navigate", makeRequest("t"))).toBe(
      "navigate in the workspace",
    );
  });

  test("unknown class with tool title quotes the title", () => {
    expect(describeOperationClass("tool.custom-probe", makeRequest("custom-probe"))).toBe(
      "run \u201Ccustom-probe\u201D",
    );
  });

  test("unknown class with no tool title falls back to generic phrase", () => {
    expect(describeOperationClass("tool.unknown", makeRequest(null))).toBe("run this tool request");
  });

  test("tool.<name> classes with numbers/dashes still hit fallback path", () => {
    expect(describeOperationClass("tool.ci-check-2", makeRequest("ci-check-2"))).toBe(
      "run \u201Cci-check-2\u201D",
    );
  });
});

describe("describeReplayScope", () => {
  const obsidian = { hostLabel: "Obsidian", resourceLabel: "this vault" };
  const vscode = { hostLabel: "VS Code", resourceLabel: "this workspace" };

  test("wildcard scope emits request-label-keyed detail", () => {
    const result = describeReplayScope(makeRequest("probeCapabilities"), obsidian);
    expect(result.summary).toBe(
      "If you replay this choice for this session or across sessions, Obsidian will reuse it when the agent tries to run \u201CprobeCapabilities\u201D in this vault.",
    );
    expect(result.detail).toBe(
      "This request does not expose a file, folder, command, or domain scope. Replay is keyed to the request label \u201CprobeCapabilities\u201D, not a domain-wide or folder-wide rule.",
    );
  });

  test("wildcard scope without tool title falls back to 'this request' label", () => {
    const result = describeReplayScope(makeRequest(null), obsidian);
    expect(result.summary).toContain("in this vault.");
    expect(result.detail).toContain("\u201Cthis request\u201D");
  });

  test("command scope uses the command as the replay key", () => {
    const result = describeReplayScope(
      makeRequest("terminal.run", { command: "git status" }),
      obsidian,
    );
    expect(result.summary).toBe(
      "If you replay this choice for this session or across sessions, Obsidian will reuse it for command \u201Cgit status\u201D in this vault.",
    );
    expect(result.detail).toBe("Replay scope comes from the command field on this request.");
  });

  test("path scope combines operation description, path, and resource label", () => {
    const result = describeReplayScope(
      makeRequest("readFile", { path: "docs/readme.md" }),
      obsidian,
    );
    expect(result.summary).toBe(
      "If you replay this choice for this session or across sessions, Obsidian will reuse it for read this file at \u201Cdocs/readme.md\u201D in this vault.",
    );
    expect(result.detail).toBe(
      "Replay scope comes from the request path \u201Cdocs/readme.md\u201D.",
    );
  });

  test("host-label and resource-label swap cleanly for a different host", () => {
    const result = describeReplayScope(makeRequest("writeFile", { path: "src/index.ts" }), vscode);
    expect(result.summary).toBe(
      "If you replay this choice for this session or across sessions, VS Code will reuse it for write this file at \u201Csrc/index.ts\u201D in this workspace.",
    );
    expect(result.detail).toBe(
      "Replay scope comes from the request path \u201Csrc/index.ts\u201D.",
    );
  });

  test("empty host-label / resource-label are substituted as-is", () => {
    const result = describeReplayScope(makeRequest("readFile", { path: "a.md" }), {
      hostLabel: "",
      resourceLabel: "",
    });
    expect(result.summary).toContain(" will reuse it for read this file at ");
    expect(result.summary).toContain(" in .");
  });
});
