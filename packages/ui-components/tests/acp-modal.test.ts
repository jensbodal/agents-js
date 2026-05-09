import { describe, expect, test } from "bun:test";
import { AcpModal, registerAllComponents } from "../src/index.ts";

describe("AcpModal", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpModal).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpModal.styles).toBeDefined();
  });

  test("styles is an array (theme + component styles)", () => {
    expect(Array.isArray(AcpModal.styles)).toBe(true);
  });

  test("registerAllComponents does not throw", () => {
    expect(() => registerAllComponents()).not.toThrow();
  });

  test("has reactive properties for open, title, closable", () => {
    const props = AcpModal.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("open")).toBeDefined();
    expect(props.get("title")).toBeDefined();
    expect(props.get("closable")).toBeDefined();
  });

  test("open property has Boolean type and is reflected", () => {
    const prop = AcpModal.elementProperties.get("open");
    expect(prop?.type).toBe(Boolean);
    expect(prop?.reflect).toBe(true);
  });

  test("title property has String type", () => {
    expect(AcpModal.elementProperties.get("title")?.type).toBe(String);
  });

  test("closable property has Boolean type", () => {
    expect(AcpModal.elementProperties.get("closable")?.type).toBe(Boolean);
  });

  test("modal dispatches acp-close event via prototype method", () => {
    const instance = Object.create(AcpModal.prototype);
    let eventType = "";
    instance.dispatchEvent = (e: Event) => {
      eventType = e.type;
      return true;
    };
    (instance as unknown as { _emitClose: () => void })._emitClose();
    expect(eventType).toBe("acp-close");
  });
});

describe("AcpModal focus-trap", () => {
  test("prototype has _setInitialFocus method", () => {
    expect(typeof (AcpModal.prototype as Record<string, unknown>)._setInitialFocus).toBe(
      "function",
    );
  });

  test("prototype has _getFocusableElements method", () => {
    expect(typeof (AcpModal.prototype as Record<string, unknown>)._getFocusableElements).toBe(
      "function",
    );
  });

  test("prototype has _trapFocus method", () => {
    expect(typeof (AcpModal.prototype as Record<string, unknown>)._trapFocus).toBe("function");
  });

  test("prototype has updated method for initial focus placement", () => {
    expect(typeof AcpModal.prototype.updated).toBe("function");
  });

  test("_handleKeydown handles Escape to emit close when closable and open", () => {
    const instance = new AcpModal() as AcpModal & {
      _handleKeydown(e: KeyboardEvent): void;
    };
    instance.open = true;
    instance.closable = true;
    const events: Event[] = [];
    instance.addEventListener("acp-close", (e: Event) => {
      events.push(e);
    });
    const event = {
      key: "Escape",
      preventDefault: () => {},
      shiftKey: false,
    } as unknown as KeyboardEvent;
    instance._handleKeydown(event);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("acp-close");
  });

  test("_handleKeydown does nothing when modal is closed", () => {
    const instance = new AcpModal() as AcpModal & {
      _handleKeydown(e: KeyboardEvent): void;
    };
    instance.open = false;
    instance.closable = true;
    const events: Event[] = [];
    instance.addEventListener("acp-close", (e: Event) => {
      events.push(e);
    });
    const event = {
      key: "Escape",
      preventDefault: () => {},
      shiftKey: false,
    } as unknown as KeyboardEvent;
    instance._handleKeydown(event);
    expect(events.length).toBe(0);
  });

  test("_handleKeydown invokes _trapFocus on Tab key when open", () => {
    const instance = new AcpModal() as AcpModal & {
      _handleKeydown(e: KeyboardEvent): void;
      _trapFocus(e: KeyboardEvent): void;
    };
    instance.open = true;
    instance.closable = true;
    let trapCalled = false;
    const originalTrap = instance._trapFocus.bind(instance);
    instance._trapFocus = (e: KeyboardEvent) => {
      trapCalled = true;
      originalTrap(e);
    };
    const event = {
      key: "Tab",
      preventDefault: () => {},
      shiftKey: false,
    } as unknown as KeyboardEvent;
    instance._handleKeydown(event);
    expect(trapCalled).toBe(true);
  });

  test("_getFocusableElements returns array from container", () => {
    const instance = new AcpModal() as AcpModal & {
      _getFocusableElements(el: HTMLElement): HTMLElement[];
    };
    // Create a mock container with querySelectorAll and no slots
    const container = {
      querySelectorAll: () => [],
    } as unknown as HTMLElement;
    const result = instance._getFocusableElements(container);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });
});

describe("AcpModal slotted focus-trap", () => {
  test("_getFocusableElements collects elements from assigned slot nodes", () => {
    const instance = new AcpModal() as AcpModal & {
      _getFocusableElements(el: HTMLElement): HTMLElement[];
    };

    // Create mock slotted button elements
    const slottedBtn1 = { matches: (s: string) => s.includes("button"), tagName: "BUTTON" };
    const slottedBtn2 = { matches: (s: string) => s.includes("button"), tagName: "BUTTON" };

    // Create a mock slot element that returns assigned elements
    const mockSlot = {
      assignedElements: () => [slottedBtn1, slottedBtn2],
    };

    // Create a container whose direct querySelectorAll returns no focusable elements
    // but has a slot with assigned elements
    const container = {
      querySelectorAll: (selector: string) => {
        if (selector === "slot") return [mockSlot];
        return [];
      },
    } as unknown as HTMLElement;

    const result = instance._getFocusableElements(container);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(slottedBtn1);
    expect(result[1]).toBe(slottedBtn2);
  });

  test("_getFocusableElements includes both shadow DOM and slotted focusable elements", () => {
    const instance = new AcpModal() as AcpModal & {
      _getFocusableElements(el: HTMLElement): HTMLElement[];
    };

    // Shadow DOM close button
    const closeBtn = { tagName: "BUTTON" };
    // Slotted input and button
    const slottedInput = { matches: (s: string) => s.includes("input"), tagName: "INPUT" };
    const slottedBtn = { matches: (s: string) => s.includes("button"), tagName: "BUTTON" };

    const mockSlot = {
      assignedElements: () => [slottedInput, slottedBtn],
    };

    const container = {
      querySelectorAll: (selector: string) => {
        if (selector === "slot") return [mockSlot];
        // The focusable selector returns the close button from shadow DOM
        return [closeBtn];
      },
    } as unknown as HTMLElement;

    const result = instance._getFocusableElements(container);
    expect(result.length).toBe(3);
    expect(result).toContain(closeBtn);
    expect(result).toContain(slottedInput);
    expect(result).toContain(slottedBtn);
  });

  test("_getFocusableElements filters non-focusable slotted elements", () => {
    const instance = new AcpModal() as AcpModal & {
      _getFocusableElements(el: HTMLElement): HTMLElement[];
    };

    // A non-interactive div should not be collected
    const slottedDiv = { matches: () => false, tagName: "DIV" };
    // An interactive button should be collected
    const slottedBtn = { matches: (s: string) => s.includes("button"), tagName: "BUTTON" };

    const mockSlot = {
      assignedElements: () => [slottedDiv, slottedBtn],
    };

    const container = {
      querySelectorAll: (selector: string) => {
        if (selector === "slot") return [mockSlot];
        return [];
      },
    } as unknown as HTMLElement;

    const result = instance._getFocusableElements(container);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(slottedBtn);
  });

  test("_getFocusableElements collects nested focusable children within slotted elements", () => {
    const instance = new AcpModal() as AcpModal & {
      _getFocusableElements(el: HTMLElement): HTMLElement[];
    };

    // A slotted div that is not itself focusable but contains a focusable input
    const nestedInput = { tagName: "INPUT" };
    const slottedDiv = {
      matches: () => false,
      tagName: "DIV",
      querySelectorAll: () => [nestedInput],
    };

    const mockSlot = {
      assignedElements: () => [slottedDiv],
    };

    const container = {
      querySelectorAll: (selector: string) => {
        if (selector === "slot") return [mockSlot];
        return [];
      },
    } as unknown as HTMLElement;

    const result = instance._getFocusableElements(container);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(nestedInput);
  });

  test("_getFocusableElements does not duplicate elements already in shadow DOM", () => {
    const instance = new AcpModal() as AcpModal & {
      _getFocusableElements(el: HTMLElement): HTMLElement[];
    };

    // A button that appears both in shadow DOM query and as a slotted element
    const sharedBtn = { matches: (s: string) => s.includes("button"), tagName: "BUTTON" };

    const mockSlot = {
      assignedElements: () => [sharedBtn],
    };

    const container = {
      querySelectorAll: (selector: string) => {
        if (selector === "slot") return [mockSlot];
        // Also returns same button from shadow DOM query
        return [sharedBtn];
      },
    } as unknown as HTMLElement;

    const result = instance._getFocusableElements(container);
    // Should deduplicate - only one entry for sharedBtn
    expect(result.length).toBe(1);
    expect(result[0]).toBe(sharedBtn);
  });

  test("_trapFocus wraps Tab from last slotted element to first focusable", () => {
    const instance = new AcpModal() as AcpModal & {
      _trapFocus(e: KeyboardEvent): void;
      _getDeepActiveElement(): Element | null;
    };
    instance.open = true;

    const closeBtn = {
      tagName: "BUTTON",
      focus: () => {},
    };
    const slottedInput = {
      tagName: "INPUT",
      matches: (s: string) => s.includes("input"),
      focus: () => {},
    };
    const slottedBtn = {
      tagName: "BUTTON",
      matches: (s: string) => s.includes("button"),
      focus: () => {},
    };

    // Track which element receives focus
    let focusedElement: unknown = null;
    closeBtn.focus = () => {
      focusedElement = closeBtn;
    };

    const mockSlot = {
      assignedElements: () => [slottedInput, slottedBtn],
    };

    const mockDialog = {
      querySelectorAll: (selector: string) => {
        if (selector === "slot") return [mockSlot];
        return [closeBtn];
      },
    };

    // Mock renderRoot to return the dialog
    Object.defineProperty(instance, "renderRoot", {
      get: () => ({
        querySelector: (sel: string) => (sel === ".dialog" ? mockDialog : null),
        activeElement: null,
      }),
    });

    // Mock _getDeepActiveElement to return the last slotted element
    instance._getDeepActiveElement = () => slottedBtn as unknown as Element;

    let prevented = false;
    const tabEvent = {
      key: "Tab",
      shiftKey: false,
      preventDefault: () => {
        prevented = true;
      },
    } as unknown as KeyboardEvent;

    instance._trapFocus(tabEvent);

    expect(prevented).toBe(true);
    expect(focusedElement).toBe(closeBtn);
  });

  test("_trapFocus wraps Shift+Tab from first focusable to last slotted element", () => {
    const instance = new AcpModal() as AcpModal & {
      _trapFocus(e: KeyboardEvent): void;
      _getDeepActiveElement(): Element | null;
    };
    instance.open = true;

    const closeBtn = {
      tagName: "BUTTON",
      focus: () => {},
    };
    const slottedInput = {
      tagName: "INPUT",
      matches: (s: string) => s.includes("input"),
      focus: () => {},
    };
    const slottedBtn = {
      tagName: "BUTTON",
      matches: (s: string) => s.includes("button"),
      focus: () => {},
    };

    // Track which element receives focus
    let focusedElement: unknown = null;
    slottedBtn.focus = () => {
      focusedElement = slottedBtn;
    };

    const mockSlot = {
      assignedElements: () => [slottedInput, slottedBtn],
    };

    const mockDialog = {
      querySelectorAll: (selector: string) => {
        if (selector === "slot") return [mockSlot];
        return [closeBtn];
      },
    };

    // Mock renderRoot to return the dialog
    Object.defineProperty(instance, "renderRoot", {
      get: () => ({
        querySelector: (sel: string) => (sel === ".dialog" ? mockDialog : null),
        activeElement: closeBtn,
      }),
    });

    // Mock _getDeepActiveElement to return the first focusable element
    instance._getDeepActiveElement = () => closeBtn as unknown as Element;

    let prevented = false;
    const shiftTabEvent = {
      key: "Tab",
      shiftKey: true,
      preventDefault: () => {
        prevented = true;
      },
    } as unknown as KeyboardEvent;

    instance._trapFocus(shiftTabEvent);

    expect(prevented).toBe(true);
    expect(focusedElement).toBe(slottedBtn);
  });

  test("_trapFocus does not wrap when focus is on a middle slotted element", () => {
    const instance = new AcpModal() as AcpModal & {
      _trapFocus(e: KeyboardEvent): void;
      _getDeepActiveElement(): Element | null;
    };
    instance.open = true;

    const closeBtn = {
      tagName: "BUTTON",
      focus: () => {},
    };
    const slottedInput = {
      tagName: "INPUT",
      matches: (s: string) => s.includes("input"),
      focus: () => {},
    };
    const slottedBtn = {
      tagName: "BUTTON",
      matches: (s: string) => s.includes("button"),
      focus: () => {},
    };

    const mockSlot = {
      assignedElements: () => [slottedInput, slottedBtn],
    };

    const mockDialog = {
      querySelectorAll: (selector: string) => {
        if (selector === "slot") return [mockSlot];
        return [closeBtn];
      },
    };

    Object.defineProperty(instance, "renderRoot", {
      get: () => ({
        querySelector: (sel: string) => (sel === ".dialog" ? mockDialog : null),
        activeElement: null,
      }),
    });

    // Mock _getDeepActiveElement to return a middle element (not first or last)
    instance._getDeepActiveElement = () => slottedInput as unknown as Element;

    let prevented = false;
    const tabEvent = {
      key: "Tab",
      shiftKey: false,
      preventDefault: () => {
        prevented = true;
      },
    } as unknown as KeyboardEvent;

    instance._trapFocus(tabEvent);

    // Should NOT prevent default because focus is not on the last element
    expect(prevented).toBe(false);
  });
});
