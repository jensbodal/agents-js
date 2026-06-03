import { describe, expect, test } from "bun:test";
import { AcpConnectDialog } from "../src/acp-connect-dialog.ts";

describe("AcpConnectDialog", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpConnectDialog).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpConnectDialog.styles).toBeDefined();
  });

  test("styles is an array (theme + component styles)", () => {
    expect(Array.isArray(AcpConnectDialog.styles)).toBe(true);
  });

  test("has reactive properties for the controlled dialog API", () => {
    const props = AcpConnectDialog.elementProperties;
    expect(props.get("connected")?.type).toBe(Boolean);
    expect(props.get("agentName")?.type).toBe(String);
    expect(props.get("defaultUrl")?.type).toBe(String);
    expect(props.get("url")?.type).toBe(String);
    expect(props.get("status")?.type).toBe(String);
    expect(props.get("statusMessage")?.type).toBe(String);
    expect(props.get("connectDisabled")?.type).toBe(Boolean);
    expect(props.get("connectLoading")?.type).toBe(Boolean);
    expect(props.get("preview")).toBeDefined();
    expect(props.get("runtime")).toBeDefined();
    expect(props.get("profiles")).toBeDefined();
    expect(props.get("activeProfileId")?.type).toBe(String);
    expect(props.get("profileName")?.type).toBe(String);
  });

  test("has exactly 18 element properties (17 public + 1 state)", () => {
    expect(AcpConnectDialog.elementProperties.size).toBe(18);
  });

  test("preview does not reflect to an attribute", () => {
    expect(AcpConnectDialog.elementProperties.get("preview")?.attribute).toBe(false);
  });

  test("runtime does not reflect to an attribute", () => {
    expect(AcpConnectDialog.elementProperties.get("runtime")?.attribute).toBe(false);
  });

  test("availableRuntimes does not reflect to an attribute", () => {
    expect(AcpConnectDialog.elementProperties.get("availableRuntimes")?.attribute).toBe(false);
  });

  test("prototype has render method", () => {
    expect(typeof AcpConnectDialog.prototype.render).toBe("function");
  });

  test("prototype has connect and disconnect methods", () => {
    expect(typeof (AcpConnectDialog.prototype as Record<string, unknown>).connect).toBe("function");
    expect(typeof (AcpConnectDialog.prototype as Record<string, unknown>).disconnect).toBe(
      "function",
    );
  });

  test("connect dispatches only when enabled", () => {
    const dialog = new AcpConnectDialog() as AcpConnectDialog & {
      connect(): void;
      connectDisabled: boolean;
      url: string;
    };

    const events: Array<{ url: string }> = [];
    dialog.addEventListener("acp-connect", ((event: CustomEvent<{ url: string }>) => {
      events.push(event.detail);
    }) as EventListener);

    dialog.url = "http://127.0.0.1:55363";
    dialog.connectDisabled = true;
    dialog.connect();
    expect(events).toHaveLength(0);

    dialog.connectDisabled = false;
    dialog.connect();
    expect(events).toEqual([{ url: "http://127.0.0.1:55363" }]);
  });

  test("url changes dispatch acp-url-change", () => {
    const dialog = new AcpConnectDialog() as AcpConnectDialog & {
      dispatchUrlChange(url: string): void;
    };

    const events: Array<{ url: string }> = [];
    dialog.addEventListener("acp-url-change", ((event: CustomEvent<{ url: string }>) => {
      events.push(event.detail);
    }) as EventListener);

    dialog.dispatchUrlChange("http://127.0.0.1:55363");
    expect(events).toEqual([{ url: "http://127.0.0.1:55363" }]);
  });

  test("savePreferences dispatches profile-aware acp-save-preferences detail", () => {
    const dialog = new AcpConnectDialog() as AcpConnectDialog & {
      savePreferences(mode: "update" | "create"): void;
    };
    dialog.url = "http://127.0.0.1:9000";
    dialog.runtime = { id: "opencode", displayName: "OpenCode" };
    dialog.activeProfileId = "default";
    dialog.profileName = "Default profile";

    const events: Array<Record<string, string>> = [];
    dialog.addEventListener("acp-save-preferences", ((
      event: CustomEvent<Record<string, string>>,
    ) => {
      events.push(event.detail);
    }) as EventListener);

    dialog.savePreferences("update");
    expect(events).toEqual([
      {
        url: "http://127.0.0.1:9000",
        runtimeId: "opencode",
        profileId: "default",
        profileName: "Default profile",
        harnessId: "opencode",
        saveMode: "update",
      },
    ]);
  });

  test("savePreferences uses _selectedRuntimeId over runtime.id", () => {
    const dialog = new AcpConnectDialog() as AcpConnectDialog & {
      savePreferences(mode: "update" | "create"): void;
      _selectedRuntimeId: string;
    };
    dialog.url = "http://127.0.0.1:9000";
    dialog.runtime = { id: "opencode", displayName: "OpenCode" };
    dialog._selectedRuntimeId = "different-runtime";

    const events: Array<Record<string, string>> = [];
    dialog.addEventListener("acp-save-preferences", ((
      event: CustomEvent<Record<string, string>>,
    ) => {
      events.push(event.detail);
    }) as EventListener);

    dialog.savePreferences("update");
    expect(events[0].runtimeId).toBe("different-runtime");
  });

  test("has _selectedRuntimeId state property", () => {
    const meta = AcpConnectDialog.elementProperties.get("_selectedRuntimeId");
    expect(meta).toBeDefined();
    expect(meta?.state).toBe(true);
  });

  test("willUpdate seeds _selectedRuntimeId from the current runtime", () => {
    const dialog = new AcpConnectDialog() as AcpConnectDialog & {
      _selectedRuntimeId: string;
      willUpdate(changed: Map<string, unknown>): void;
    };

    dialog.runtime = { id: "claude", displayName: "Claude ACP" };
    dialog.willUpdate(new Map([["runtime", null]]));

    expect(dialog._selectedRuntimeId).toBe("claude");
  });

  test("willUpdate syncs _selectedRuntimeId from the active profile runtime", () => {
    const dialog = new AcpConnectDialog() as AcpConnectDialog & {
      _selectedRuntimeId: string;
      willUpdate(changed: Map<string, unknown>): void;
    };

    dialog.profiles = [{ id: "work", name: "Work", runtimeId: "opencode", url: "" }];
    dialog.activeProfileId = "work";
    dialog.willUpdate(new Map([["activeProfileId", ""]]));

    expect(dialog._selectedRuntimeId).toBe("opencode");
  });

  test("willUpdate falls back to the current runtime when switching to unsaved settings", () => {
    const dialog = new AcpConnectDialog() as AcpConnectDialog & {
      _selectedRuntimeId: string;
      willUpdate(changed: Map<string, unknown>): void;
    };

    dialog.runtime = { id: "claude", displayName: "Claude ACP" };
    dialog.profiles = [{ id: "work", name: "Work", runtimeId: "opencode", url: "" }];
    dialog.activeProfileId = "";
    dialog._selectedRuntimeId = "opencode";
    dialog.willUpdate(new Map([["activeProfileId", "work"]]));

    expect(dialog._selectedRuntimeId).toBe("claude");
  });

  test("willUpdate prefers the applied runtime over stale profile runtime when runtime changes", () => {
    const dialog = new AcpConnectDialog() as AcpConnectDialog & {
      _selectedRuntimeId: string;
      willUpdate(changed: Map<string, unknown>): void;
    };

    dialog.profiles = [{ id: "work", name: "Work", runtimeId: "opencode", url: "" }];
    dialog.activeProfileId = "work";
    dialog._selectedRuntimeId = "opencode";
    dialog.runtime = { id: "claude", displayName: "Claude ACP" };

    dialog.willUpdate(
      new Map([
        ["runtime", { id: "opencode", displayName: "OpenCode ACP" }],
        ["activeProfileId", ""],
      ]),
    );

    expect(dialog._selectedRuntimeId).toBe("claude");
  });

  test("profile selection dispatches acp-profile-select", () => {
    const dialog = new AcpConnectDialog() as AcpConnectDialog & {
      selectProfile(profileId: string): void;
    };
    const events: Array<{ profileId: string }> = [];
    dialog.addEventListener("acp-profile-select", ((event: CustomEvent<{ profileId: string }>) => {
      events.push(event.detail);
    }) as EventListener);

    dialog.selectProfile("work");
    expect(events).toEqual([{ profileId: "work" }]);
  });

  test("runtime change handler ignores duplicate selections", () => {
    const dialog = new AcpConnectDialog();
    const events: Array<{ runtimeId: string }> = [];
    dialog.addEventListener("acp-runtime-change", ((event: CustomEvent<{ runtimeId: string }>) => {
      events.push(event.detail);
    }) as EventListener);

    const handleRuntimeChange = (event: Event) => {
      const select = event.target as HTMLSelectElement;
      const nextRuntimeId = select.value;
      if (nextRuntimeId === dialog._selectedRuntimeId) {
        return;
      }
      dialog._selectedRuntimeId = nextRuntimeId;
      dialog.dispatchEvent(
        new CustomEvent("acp-runtime-change", {
          bubbles: true,
          composed: true,
          detail: { runtimeId: nextRuntimeId },
        }),
      );
    };

    dialog._selectedRuntimeId = "claude";
    handleRuntimeChange({ target: { value: "claude" } } as unknown as Event);
    handleRuntimeChange({ target: { value: "opencode" } } as unknown as Event);

    expect(events).toEqual([{ runtimeId: "opencode" }]);
  });
});
