import { describe, expect, test } from "bun:test";
import {
  A2uiMessageSchema,
  ACP_CATALOG_ID,
  ACP_COMPONENT_APIS,
  AcpCatalog,
  AnyComponentSchema,
  ChatAppApi,
  CodeBlockApi,
  ElicitationFormApi,
  MessageApi,
  MessageProcessor,
  PermissionModalApi,
  PromptInputApi,
  StreamingTextApi,
  TranscriptApi,
} from "../src/index.ts";

const MINIMAL_PROPS_BY_NAME: Record<string, unknown> = {
  AcpChatApp: { transcript: "t", promptInput: "p" },
  AcpTranscript: { children: ["m1", "m2"] },
  AcpMessage: { role: "agent", body: "hello" },
  AcpStreamingText: { text: "streaming..." },
  AcpPromptInput: {
    value: { path: "/prompt" },
    submit: { event: { name: "send" } },
  },
  AcpConnectDialog: { runtimes: ["claude", "gemini"] },
  AcpElicitationForm: {
    children: ["field1"],
    submit: { event: { name: "submit" } },
  },
  AcpPermissionModal: {
    operation: "Edit file",
    approve: { event: { name: "approve" } },
    deny: { event: { name: "deny" } },
  },
  AcpPermissionModeSelector: { value: { path: "/mode" } },
  AcpWriteGateModal: {
    path: "/workspace/file.ts",
    allow: { event: { name: "allow" } },
    block: { event: { name: "block" } },
  },
  AcpAuthSelector: { methods: ["oauth", "api-key"] },
  AcpDebugPanel: { logs: { path: "/logs" } },
  AcpStatusBar: { status: "connected" },
  AcpCodeBlock: { code: "console.log('hi');" },
};

describe("ACP custom catalog", () => {
  test("catalog has the pinned ACP id", () => {
    expect(AcpCatalog.id).toBe(ACP_CATALOG_ID);
    expect(ACP_CATALOG_ID).toBe("https://agents-js.bodal.dev/catalog/acp/0.1");
  });

  test("catalog registers every ACP component api", () => {
    const catalogNames = Array.from(AcpCatalog.components.keys()).sort();
    const apiNames = ACP_COMPONENT_APIS.map((api) => api.name).sort();
    expect(catalogNames).toEqual(apiNames);
    // Guardrail: we lose coverage if someone renames a component without
    // updating the ACP_COMPONENT_APIS list.
    expect(apiNames.length).toBeGreaterThanOrEqual(14);
  });

  test.each(
    ACP_COMPONENT_APIS.map((api) => [api.name, api] as const),
  )("%s parses minimal valid props", (_name, api) => {
    const props = MINIMAL_PROPS_BY_NAME[api.name];
    if (props === undefined) {
      throw new Error(
        `Missing minimal-props fixture for ${api.name} — add an entry to MINIMAL_PROPS_BY_NAME.`,
      );
    }
    const result = api.schema.safeParse(props);
    if (!result.success) {
      throw new Error(`${api.name} failed to parse minimal props: ${result.error.message}`);
    }
    expect(result.success).toBe(true);
  });

  test("every component api parses a minimal valid props object", () => {
    const fixtures: Array<[(typeof ACP_COMPONENT_APIS)[number], unknown]> = [
      [ChatAppApi, { transcript: "t", promptInput: "p" }],
      [TranscriptApi, { children: ["m1", "m2"] }],
      [MessageApi, { role: "agent", body: "hello" }],
      [StreamingTextApi, { text: "streaming..." }],
      [
        PromptInputApi,
        {
          value: { path: "/prompt" },
          submit: { event: { name: "send" } },
        },
      ],
      [
        ElicitationFormApi,
        {
          children: ["field1"],
          submit: { event: { name: "submit" } },
        },
      ],
      [
        PermissionModalApi,
        {
          operation: "Edit file",
          approve: { event: { name: "approve" } },
          deny: { event: { name: "deny" } },
        },
      ],
      [CodeBlockApi, { code: "console.log('hi');" }],
    ];

    for (const [api, props] of fixtures) {
      const result = api.schema.safeParse(props);
      if (!result.success) {
        throw new Error(`${api.name} failed to parse minimal props: ${result.error.message}`);
      }
      expect(result.success).toBe(true);
    }
  });

  test("strict schemas reject unknown properties", () => {
    const result = MessageApi.schema.safeParse({
      role: "user",
      body: "hi",
      bogusField: true,
    });
    expect(result.success).toBe(false);
  });

  test("component entries embed in `AnyComponent` envelope shape", () => {
    // A2UI envelopes have the shape { id, component, ...props }. Validate that
    // ACP components serialize into that envelope without drift.
    const envelope = {
      id: "root",
      component: ChatAppApi.name,
      transcript: "transcript-1",
      promptInput: "input-1",
    };
    const parsed = AnyComponentSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
  });

  test("dynamic bindings (JSON Pointer) validate", () => {
    // Regression for the DynamicString re-export — if the re-export from
    // @a2ui/web_core drifts we catch it here.
    const parsed = MessageApi.schema.safeParse({
      role: "agent",
      body: { path: "/messages/0/content" },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("interop with @a2ui/web_core", () => {
  test("MessageProcessor accepts the ACP catalog", () => {
    const processor = new MessageProcessor([AcpCatalog]);
    expect(processor.model).toBeDefined();
    // Sanity check on the public surface — if upstream renames this method the
    // re-export shape changes and we catch it.
    expect(typeof processor.processMessages).toBe("function");
    expect(typeof processor.getClientCapabilities).toBe("function");
  });

  test("MessageProcessor processes a createSurface + updateComponents tree using the ACP catalog", () => {
    const processor = new MessageProcessor([AcpCatalog]);
    const messages = [
      {
        version: "v0.9",
        createSurface: {
          surfaceId: "chat",
          catalogId: ACP_CATALOG_ID,
        },
      },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "chat",
          components: [
            {
              id: "root",
              component: "AcpChatApp",
              transcript: "t",
              promptInput: "p",
            },
            {
              id: "t",
              component: "AcpTranscript",
              children: ["m1"],
            },
            {
              id: "m1",
              component: "AcpMessage",
              role: "agent",
              body: "hello",
            },
            {
              id: "p",
              component: "AcpPromptInput",
              value: { path: "/prompt" },
            },
          ],
        },
      },
    ];

    // Wire-level validation first: every message must match the v0.9 schema.
    for (const msg of messages) {
      const parsed = A2uiMessageSchema.safeParse(msg);
      if (!parsed.success) {
        throw new Error(`A2UI message failed to parse: ${parsed.error.message}`);
      }
    }

    // Then feed through the processor — this exercises the end-to-end path
    // (surface creation, component hydration) and will throw on any mismatch.
    expect(() => processor.processMessages(messages as never)).not.toThrow();

    const surface = processor.model.getSurface("chat");
    expect(surface).toBeDefined();
    expect(surface?.catalog.id).toBe(ACP_CATALOG_ID);
  });
});
