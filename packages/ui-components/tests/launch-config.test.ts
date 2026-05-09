import { describe, expect, test } from "bun:test";
import { isHostBridgeActiveForTarget, resolveBrowserLaunchConfig } from "../src/launch-config.ts";

describe("resolveBrowserLaunchConfig", () => {
  test("uses query url over saved and launcher env defaults", () => {
    const config = resolveBrowserLaunchConfig({
      search: "?target=http://127.0.0.1:61001",
      savedUrl: "http://127.0.0.1:62001",
      envTargetUrl: "http://127.0.0.1:63001",
      envWsUrl: "ws://127.0.0.1:63002",
    });

    expect(config.defaultTargetUrl).toBe("http://127.0.0.1:61001");
    expect(config.queryTargetUrl).toBe("http://127.0.0.1:61001");
    expect(config.savedTargetUrl).toBe("http://127.0.0.1:62001");
    expect(config.envTargetUrl).toBe("http://127.0.0.1:63001");
  });

  test("uses saved url over launcher env when no query override is present", () => {
    const config = resolveBrowserLaunchConfig({
      search: "",
      savedUrl: "http://localhost:61001",
      envTargetUrl: "http://127.0.0.1:63001",
      envWsUrl: "ws://127.0.0.1:63002",
    });

    expect(config.defaultTargetUrl).toBe("http://localhost:61001");
    expect(config.hostBridgeTargetUrl).toBe("http://127.0.0.1:63001");
    expect(config.hostBridgeUrl).toBe("ws://127.0.0.1:63002");
  });

  test("uses launcher env when nothing was saved", () => {
    const config = resolveBrowserLaunchConfig({
      search: "",
      savedUrl: "",
      envTargetUrl: "http://127.0.0.1:63001",
      envWsUrl: "ws://127.0.0.1:63002",
    });

    expect(config.defaultTargetUrl).toBe("http://127.0.0.1:63001");
    expect(config.hostBridgeTargetUrl).toBe("http://127.0.0.1:63001");
    expect(config.hostBridgeUrl).toBe("ws://127.0.0.1:63002");
  });

  test("requires an explicit query or launcher target before pairing a host bridge", () => {
    const config = resolveBrowserLaunchConfig({
      search: "",
      savedUrl: "http://localhost:61001",
      envTargetUrl: "",
      envWsUrl: "ws://127.0.0.1:63002",
    });

    expect(config.defaultTargetUrl).toBe("http://localhost:61001");
    expect(config.hostBridgeTargetUrl).toBeNull();
    expect(config.hostBridgeUrl).toBeNull();
  });

  test("uses explicit ?ws over launcher ws env", () => {
    const config = resolveBrowserLaunchConfig({
      search: "?target=http://127.0.0.1:61001&ws=ws://127.0.0.1:61002",
      savedUrl: "",
      envTargetUrl: "http://127.0.0.1:63001",
      envWsUrl: "ws://127.0.0.1:63002",
    });

    expect(config.hostBridgeTargetUrl).toBe("http://127.0.0.1:61001");
    expect(config.hostBridgeUrl).toBe("ws://127.0.0.1:61002");
    expect(config.queryWsUrl).toBe("ws://127.0.0.1:61002");
    expect(config.restoreSavedRuntime).toBe(false);
  });

  test("keeps saved runtime restoration enabled for non-canonical query overrides", () => {
    const config = resolveBrowserLaunchConfig({
      search: "?target=http://127.0.0.1:61001",
      savedUrl: "http://127.0.0.1:62001",
      envTargetUrl: "http://127.0.0.1:63001",
      envWsUrl: "ws://127.0.0.1:63002",
    });

    expect(config.restoreSavedRuntime).toBe(true);
  });

  test("keeps saved runtime restoration enabled for saved or launcher default sessions", () => {
    const config = resolveBrowserLaunchConfig({
      search: "",
      savedUrl: "http://127.0.0.1:62001",
      envTargetUrl: "http://127.0.0.1:63001",
      envWsUrl: "ws://127.0.0.1:63002",
    });

    expect(config.restoreSavedRuntime).toBe(true);
  });

  test("accepts the legacy ?url override for compatibility", () => {
    const config = resolveBrowserLaunchConfig({
      search: "?url=http://127.0.0.1:61001",
      savedUrl: "http://127.0.0.1:62001",
      envTargetUrl: "http://127.0.0.1:63001",
      envWsUrl: "ws://127.0.0.1:63002",
    });

    expect(config.defaultTargetUrl).toBe("http://127.0.0.1:61001");
    expect(config.queryTargetUrl).toBe("http://127.0.0.1:61001");
    expect(config.savedTargetUrl).toBe("http://127.0.0.1:62001");
    expect(config.envTargetUrl).toBe("http://127.0.0.1:63001");
  });
});

describe("isHostBridgeActiveForTarget", () => {
  test("stays active only while the target matches the paired launch target", () => {
    expect(isHostBridgeActiveForTarget("http://127.0.0.1:61001/", "http://127.0.0.1:61001")).toBe(
      true,
    );
    expect(isHostBridgeActiveForTarget("http://localhost:61001", "http://127.0.0.1:61001")).toBe(
      false,
    );
    expect(isHostBridgeActiveForTarget("", "http://127.0.0.1:61001")).toBe(false);
  });
});
