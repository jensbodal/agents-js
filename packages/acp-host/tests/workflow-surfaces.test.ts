import { describe, expect, test } from "bun:test";
import { defaultWorkflowCopy, resolveWorkflowCopy } from "../src/workflow-copy.ts";
import {
  deriveWorkflowSurfaceState,
  describeWorkflowError,
  formatToolCallStatus,
  summarizeToolGroup,
} from "../src/workflow-surfaces.ts";

describe("deriveWorkflowSurfaceState", () => {
  test("summarizes plan progress and queue semantics", () => {
    const workflow = deriveWorkflowSurfaceState({
      status: "prompting",
      promptQueue: [[{ type: "text", text: "follow up" }]],
      plan: [
        { content: "Inspect workspace", status: "completed", priority: "high" },
        { content: "Implement workflow surfaces", status: "in_progress", priority: "high" },
        { content: "Run verification", status: "pending", priority: "medium" },
      ],
      currentTurn: {
        textChunks: ["Working"],
        toolCalls: new Map(),
        turnItems: [{ type: "text", startIndex: 0 }],
      },
    });

    expect(workflow.plan_surface.summary).toBe("1 out of 3 tasks completed");
    expect(workflow.plan_surface.currentEntryIndex).toBe(1);
    expect(workflow.composer_surface.mode).toBe("queueing");
    expect(workflow.activity_surface.queuedFollowUpCount).toBe(1);
    expect(workflow.interrupt_surface.queue.pending).toBe(true);
    expect(workflow.interrupt_surface.nextActionSummary).toContain(
      "run after the current turn finishes",
    );
  });

  test("captures trailing tool-block summaries and post-tool progress", () => {
    const workflow = deriveWorkflowSurfaceState({
      status: "prompting",
      currentTurn: {
        textChunks: ["Searching the repo"],
        toolCalls: new Map([
          [
            "tool-1",
            {
              id: "tool-1",
              name: "workspace.search",
              status: "completed",
              richContent: [{ type: "terminal", terminalId: "term-1" }],
            },
          ],
          [
            "tool-2",
            {
              id: "tool-2",
              name: "readTextFile",
              status: "failed",
            },
          ],
        ]),
        turnItems: [
          { type: "tool_call", id: "tool-1" },
          { type: "tool_call", id: "tool-2" },
        ],
      },
    });

    expect(workflow.transcript_surface.toolBlock.summary).toBe("2 tool calls");
    expect(workflow.transcript_surface.toolBlock.statusText).toBe("1 failed");
    expect(workflow.transcript_surface.postToolProgressText).toBe(
      "A tool failed, but the agent is still thinking through the next response.",
    );
    expect(workflow.activity_surface.runningTerminalCount).toBe(0);
  });

  test("exposes pending steer, running terminals, and background agents in activity items", () => {
    const workflow = deriveWorkflowSurfaceState(
      {
        status: "cancelling",
        promptQueue: [[{ type: "text", text: "older queued item" }]],
        currentTurn: {
          textChunks: [],
          toolCalls: {
            "tool-1": {
              id: "tool-1",
              name: "workspace.terminal",
              status: "running",
              richContent: [{ type: "terminal", terminalId: "term-9" }],
            },
          },
          turnItems: [{ type: "tool_call", id: "tool-1" }],
        },
      },
      {
        pendingSteer: true,
        backgroundAgents: [
          {
            id: "agent-1",
            kind: "background_agent",
            label: "Ampere",
            detail: "Reviewing the host mapper",
            status: "active",
          },
        ],
      },
    );

    expect(workflow.composer_surface.mode).toBe("steering");
    expect(workflow.activity_surface.runningTerminalCount).toBe(1);
    expect(workflow.activity_surface.backgroundAgentCount).toBe(1);
    expect(workflow.activity_surface.items.some((item) => item.id === "pending-steer")).toBe(true);
    expect(workflow.interrupt_surface.steer.pending).toBe(true);
    expect(workflow.interrupt_surface.nextActionSummary).toContain("replace queued follow-ups");
  });

  test("composer surface distinguishes running terminals and background agents while queued work exists", () => {
    const terminalWorkflow = deriveWorkflowSurfaceState({
      status: "prompting",
      promptQueue: [[{ type: "text", text: "follow up" }]],
      currentTurn: {
        textChunks: ["Working"],
        toolCalls: {
          "tool-1": {
            id: "tool-1",
            name: "workspace.terminal",
            status: "running",
            richContent: [{ type: "terminal", terminalId: "term-1" }],
          },
        },
        turnItems: [{ type: "tool_call", id: "tool-1" }],
      },
    });

    expect(terminalWorkflow.composer_surface.detailText).toBe(
      "A terminal command is still running. 1 follow-up is queued and will run after the current turn finishes.",
    );

    const backgroundWorkflow = deriveWorkflowSurfaceState(
      {
        status: "prompting",
        promptQueue: [[{ type: "text", text: "follow up" }]],
        currentTurn: {
          textChunks: ["Working"],
          toolCalls: {},
          turnItems: [],
        },
      },
      {
        backgroundAgents: [
          {
            id: "agent-1",
            kind: "background_agent",
            label: "Ampere",
            detail: "Reviewing the host mapper",
            status: "active",
          },
        ],
      },
    );

    expect(backgroundWorkflow.composer_surface.detailText).toBe(
      "A background agent is still working. 1 follow-up is queued and will run after the current turn finishes.",
    );
  });
});

describe("WorkflowCopyMap", () => {
  test("defaultWorkflowCopy provides all required keys", () => {
    expect(defaultWorkflowCopy.idleLabel).toBe("Idle");
    expect(defaultWorkflowCopy.readyLabel).toBe("Ready");
    expect(defaultWorkflowCopy.toolStatusDone).toBe("Done");
    expect(defaultWorkflowCopy.planProgress(2, 5)).toBe("2 out of 5 tasks completed");
    expect(defaultWorkflowCopy.followUpsQueued(3)).toBe("3 follow-ups are queued");
    expect(defaultWorkflowCopy.multipleToolsRunning(4)).toBe("4 tool calls are running.");
  });

  test("resolveWorkflowCopy returns defaults when no overrides provided", () => {
    const copy = resolveWorkflowCopy();
    expect(copy).toBe(defaultWorkflowCopy);
  });

  test("resolveWorkflowCopy merges partial overrides with defaults", () => {
    const copy = resolveWorkflowCopy({ readyLabel: "Bereit" });
    expect(copy.readyLabel).toBe("Bereit");
    expect(copy.idleLabel).toBe("Idle");
  });

  test("deriveWorkflowSurfaceState accepts copy overrides and applies them", () => {
    const workflow = deriveWorkflowSurfaceState(
      { status: "idle" },
      {},
      { idleDetail: "Sesión no iniciada." },
    );
    expect(workflow.composer_surface.detailText).toBe("Sesión no iniciada.");
    expect(workflow.composer_surface.label).toBe("Idle");
  });

  test("formatToolCallStatus uses copy map for labels", () => {
    const customCopy = resolveWorkflowCopy({ toolStatusDone: "Fertig" });
    expect(formatToolCallStatus("completed", customCopy)).toBe("Fertig");
    expect(formatToolCallStatus("completed")).toBe("Done");
  });

  test("describeWorkflowError uses copy map for error messages", () => {
    const customCopy = resolveWorkflowCopy({
      errorSessionFailed: "Sitzung fehlgeschlagen.",
      errorSessionFailedHint: "Erneut versuchen.",
    });
    const result = describeWorkflowError(null, customCopy);
    expect(result.summary).toBe("Sitzung fehlgeschlagen.");
    expect(result.actionHint).toBe("Erneut versuchen.");
  });

  test("summarizeToolGroup uses copy map for status labels", () => {
    const customCopy = resolveWorkflowCopy({
      toolGroupRunning: "Läuft",
      singleToolFallbackName: "Werkzeugaufruf",
    });
    const result = summarizeToolGroup(
      [{ id: "t1", name: "search", status: "running" }],
      customCopy,
    );
    expect(result.status).toBe("Läuft");
  });

  test("plan surface uses copy map for progress summary", () => {
    const workflow = deriveWorkflowSurfaceState(
      {
        status: "prompting",
        plan: [
          { content: "A", status: "completed", priority: "high" },
          { content: "B", status: "in_progress", priority: "high" },
        ],
        currentTurn: { textChunks: [], toolCalls: new Map(), turnItems: [] },
      },
      {},
      { planProgress: (c, t) => `${c}/${t} erledigt` },
    );
    expect(workflow.plan_surface.summary).toBe("1/2 erledigt");
  });

  test("defaultWorkflowCopy provides new interpolated copy keys", () => {
    expect(defaultWorkflowCopy.queueBoundarySuffix).toBe(
      "and will run after the current turn finishes.",
    );
    expect(defaultWorkflowCopy.multiToolSummary(5)).toBe("5 tool calls");
    expect(defaultWorkflowCopy.permissionNeededDetail("file write")).toBe(
      "Approval is needed for file write.",
    );
    expect(defaultWorkflowCopy.permissionDialogHelper("file write")).toBe(
      "A permission dialog is open for file write.",
    );
    expect(defaultWorkflowCopy.permissionContinueHint).toBe(
      "Choose an option to let the agent continue.",
    );
    expect(defaultWorkflowCopy.elicitationNeededDetail("Settings")).toBe(
      "Input is needed in Settings.",
    );
    expect(defaultWorkflowCopy.unknownStatusLabel("custom_state")).toBe("Custom State");
  });

  test("resolveWorkflowCopy merges new function-typed overrides", () => {
    const copy = resolveWorkflowCopy({
      permissionNeededDetail: (target) => `Genehmigung für ${target} erforderlich.`,
      multiToolSummary: (count) => `${count} Werkzeugaufrufe`,
    });
    expect(copy.permissionNeededDetail("Datei")).toBe("Genehmigung für Datei erforderlich.");
    expect(copy.multiToolSummary(3)).toBe("3 Werkzeugaufrufe");
    // defaults preserved
    expect(copy.elicitationNeededDetail("Form")).toBe("Input is needed in Form.");
  });

  test("permission surface uses copy map for detail and helper text", () => {
    const workflow = deriveWorkflowSurfaceState(
      {
        status: "waiting_permission",
        currentTurn: {
          textChunks: [],
          toolCalls: new Map(),
          turnItems: [],
          pendingPermission: {
            request: { toolCall: { title: "rm -rf" } },
          },
        },
      },
      {},
      {
        permissionNeededDetail: (target) => `Freigabe benötigt: ${target}.`,
        permissionDialogHelper: (target) => `Berechtigungsdialog für ${target}.`,
        permissionContinueHint: "Wähle eine Option.",
      },
    );
    expect(workflow.composer_surface.detailText).toContain("Freigabe benötigt: rm -rf.");
    expect(workflow.composer_surface.helperText).toContain("Berechtigungsdialog für rm -rf.");
    expect(workflow.composer_surface.helperText).toContain("Wähle eine Option.");
  });

  test("elicitation surface uses copy map for detail text", () => {
    const workflow = deriveWorkflowSurfaceState(
      {
        status: "waiting_elicitation",
        pendingElicitation: {
          request: {
            mode: "form",
            message: "Provide API key",
            sessionId: "test",
            requestedSchema: { title: "API Key" },
          },
        },
        currentTurn: { textChunks: [], toolCalls: new Map(), turnItems: [] },
      },
      {},
      {
        elicitationNeededDetail: (title) => `Eingabe erforderlich in ${title}.`,
      },
    );
    expect(workflow.composer_surface.detailText).toContain("Eingabe erforderlich in API Key.");
  });

  test("multi-tool summary uses copy map", () => {
    const customCopy = resolveWorkflowCopy({
      multiToolSummary: (count) => `${count} Werkzeugaufrufe`,
    });
    const result = summarizeToolGroup(
      [
        { id: "t1", name: "search", status: "completed" },
        { id: "t2", name: "read", status: "completed" },
      ],
      customCopy,
    );
    expect(result.summary).toBe("2 Werkzeugaufrufe");
  });

  test("queue boundary suffix uses copy map", () => {
    const workflow = deriveWorkflowSurfaceState(
      {
        status: "prompting",
        promptQueue: [[{ type: "text", text: "follow up" }]],
        currentTurn: { textChunks: ["Working"], toolCalls: new Map(), turnItems: [] },
      },
      {},
      { queueBoundarySuffix: "y se ejecutará después." },
    );
    expect(workflow.composer_surface.detailText).toContain("y se ejecutará después.");
  });

  test("unknown status label uses copy map", () => {
    const workflow = deriveWorkflowSurfaceState(
      { status: "some_unknown_status" as never },
      {},
      { unknownStatusLabel: (s) => `[${s}]` },
    );
    expect(workflow.composer_surface.label).toBe("[some_unknown_status]");
  });
});
