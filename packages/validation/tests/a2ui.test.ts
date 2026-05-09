import { describe, expect, test } from "bun:test";
import { AcpCatalog } from "@agents-js/a2ui-types";
import {
  BASIC_CATALOG_ID,
  getBasicCatalog,
  isA2uiMessage,
  ValidationError,
  validateA2uiComponent,
  validateA2uiMessage,
  validateA2uiSurfaceTree,
} from "../src/index.ts";

describe("validateA2uiMessage", () => {
  test("validates CreateSurface", () => {
    const msg = {
      version: "v0.9",
      createSurface: {
        surfaceId: "surface-1",
        catalogId: BASIC_CATALOG_ID,
      },
    };

    const result = validateA2uiMessage(msg);
    expect(result.valid).toBe(true);
  });

  test("validates UpdateComponents", () => {
    const msg = {
      version: "v0.9",
      updateComponents: {
        surfaceId: "surface-1",
        components: [{ component: "Text", id: "root", text: "hello" }],
      },
    };

    const result = validateA2uiMessage(msg);
    expect(result.valid).toBe(true);
  });

  test("validates UpdateDataModel", () => {
    const msg = {
      version: "v0.9",
      updateDataModel: {
        surfaceId: "surface-1",
        path: "/user/name",
        value: "Ada",
      },
    };

    const result = validateA2uiMessage(msg);
    expect(result.valid).toBe(true);
  });

  test("validates DeleteSurface", () => {
    const msg = {
      version: "v0.9",
      deleteSurface: { surfaceId: "surface-1" },
    };

    const result = validateA2uiMessage(msg);
    expect(result.valid).toBe(true);
  });

  test("rejects message with wrong version", () => {
    const msg = {
      version: "v0.8",
      deleteSurface: { surfaceId: "surface-1" },
    };

    const result = validateA2uiMessage(msg);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  test("rejects message missing the required discriminator payload", () => {
    const msg = { version: "v0.9" };
    const result = validateA2uiMessage(msg);
    expect(result.valid).toBe(false);
  });

  test("rejects CreateSurface missing catalogId", () => {
    const msg = {
      version: "v0.9",
      createSurface: { surfaceId: "surface-1" },
    };
    const result = validateA2uiMessage(msg);
    expect(result.valid).toBe(false);
  });
});

describe("isA2uiMessage", () => {
  test("returns true for a valid DeleteSurface", () => {
    expect(
      isA2uiMessage({
        version: "v0.9",
        deleteSurface: { surfaceId: "s" },
      }),
    ).toBe(true);
  });

  test("returns false for garbage", () => {
    expect(isA2uiMessage({ hello: "world" })).toBe(false);
    expect(isA2uiMessage(null)).toBe(false);
    expect(isA2uiMessage(42)).toBe(false);
  });
});

describe("validateA2uiComponent (basic catalog)", () => {
  test("validates a Text component", () => {
    const result = validateA2uiComponent({
      component: "Text",
      id: "title",
      text: "hello",
    });
    expect(result.valid).toBe(true);
  });

  test("validates a Button component with an action", () => {
    const result = validateA2uiComponent({
      component: "Button",
      id: "go",
      child: "t",
      action: { event: { name: "submit" } },
    });
    expect(result.valid).toBe(true);
  });

  test("rejects unknown component", () => {
    const result = validateA2uiComponent({
      component: "NotAThing",
      id: "x",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.message).toContain("NotAThing");
    }
  });

  test("rejects component entry missing the 'component' field", () => {
    const result = validateA2uiComponent({ id: "x" });
    expect(result.valid).toBe(false);
  });

  test("rejects Text component with invalid prop shape", () => {
    const result = validateA2uiComponent({
      component: "Text",
      text: 42, // must be string/binding/function-call
    });
    expect(result.valid).toBe(false);
  });
});

describe("validateA2uiComponent (custom ACP catalog)", () => {
  test("validates an AcpMessage component", () => {
    const result = validateA2uiComponent(
      {
        component: "AcpMessage",
        id: "m-1",
        role: "agent",
        body: "Hello from the agent.",
      },
      AcpCatalog,
    );
    expect(result.valid).toBe(true);
  });

  test("rejects AcpMessage with invalid role", () => {
    const result = validateA2uiComponent(
      {
        component: "AcpMessage",
        id: "m-1",
        role: "stranger",
        body: "hi",
      },
      AcpCatalog,
    );
    expect(result.valid).toBe(false);
  });

  test("rejects basic catalog component when ACP catalog is supplied", () => {
    const result = validateA2uiComponent({ component: "Text", text: "hi" }, AcpCatalog);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.issues[0]?.message).toContain("not registered");
    }
  });
});

describe("validateA2uiSurfaceTree", () => {
  test("validates a tree of basic components", () => {
    const result = validateA2uiSurfaceTree([
      { component: "Column", id: "root", children: ["t"] },
      { component: "Text", id: "t", text: "hi" },
    ]);
    expect(result.valid).toBe(true);
  });

  test("rejects an empty tree", () => {
    const result = validateA2uiSurfaceTree([]);
    expect(result.valid).toBe(false);
  });

  test("rejects a non-array input", () => {
    const result = validateA2uiSurfaceTree({ not: "array" });
    expect(result.valid).toBe(false);
  });

  test("surfaces index-scoped path on per-entry failure", () => {
    const result = validateA2uiSurfaceTree([
      { component: "Text", text: "ok" },
      { component: "Unknown", id: "x" },
    ]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.issues[0]?.path.startsWith("[1]")).toBe(true);
    }
  });

  test("validates an ACP tree when given AcpCatalog", () => {
    const result = validateA2uiSurfaceTree(
      [
        {
          component: "AcpMessage",
          id: "m-1",
          role: "user",
          body: "ping",
        },
      ],
      AcpCatalog,
    );
    expect(result.valid).toBe(true);
  });
});

describe("getBasicCatalog", () => {
  test("returns the same catalog instance on repeated calls", () => {
    const a = getBasicCatalog();
    const b = getBasicCatalog();
    expect(a).toBe(b);
    expect(a.id).toBe(BASIC_CATALOG_ID);
  });
});
