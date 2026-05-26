import { describe, expect, test } from "bun:test";
import { ACP_ARG_SPEC } from "../src/acp.ts";
import { BRIDGE_ARG_SPEC } from "../src/bridge.ts";
import { MCP_BRIDGE_ARG_SPEC, MCP_SETUP_ARG_SPEC } from "../src/mcp.ts";
import { SEND_ARG_SPEC } from "../src/send.ts";
import { SERVE_ARG_SPEC } from "../src/serve.ts";
import {
  type HarnessArg,
  type HarnessesArg,
  type HostPortArgs,
  harnessArg,
  harnessesArg,
  hostPortArgs,
  type RegistrySyncArg,
  type RuntimeLogArgs,
  type RuntimeSelectArgs,
  registrySyncArg,
  runtimeLogArgs,
  runtimeSelectArgs,
} from "../src/shared-arg-specs.ts";

describe("hostPortArgs", () => {
  test("declares --host and --port", () => {
    const spec = hostPortArgs<HostPortArgs>();
    expect(Object.keys(spec).sort()).toEqual(["--host", "--port"]);
    expect(spec["--host"]?.kind).toBe("value");
    expect(spec["--port"]?.kind).toBe("value");
  });

  test("--host assigns the raw string and --port parses an integer", () => {
    const spec = hostPortArgs<HostPortArgs>();
    const acc: HostPortArgs = {};
    spec["--host"]?.assign(acc, "127.0.0.1");
    spec["--port"]?.assign(acc, "61001");
    expect(acc).toEqual({ host: "127.0.0.1", port: 61001 });
  });
});

describe("runtimeLogArgs", () => {
  test("declares the runtime log/env flag set", () => {
    const spec = runtimeLogArgs<RuntimeLogArgs>();
    expect(Object.keys(spec).sort()).toEqual([
      "--default-model",
      "--opencode-disable-external-plugins",
      "--runtime-log-level",
    ]);
    expect(spec["--runtime-log-level"]?.kind).toBe("value");
    expect(spec["--default-model"]?.kind).toBe("value");
    expect(spec["--opencode-disable-external-plugins"]?.kind).toBe("flag");
  });

  test("--opencode-disable-external-plugins flips the boolean knob", () => {
    const spec = runtimeLogArgs<RuntimeLogArgs>();
    const acc: RuntimeLogArgs = {};
    const entry = spec["--opencode-disable-external-plugins"];
    if (entry?.kind !== "flag") throw new Error("expected flag entry");
    entry.assign(acc);
    expect(acc.opencodeDisableExternalPlugins).toBe(true);
  });
});

describe("harnessArg", () => {
  test("declares --harness only", () => {
    const spec = harnessArg<HarnessArg>();
    expect(Object.keys(spec)).toEqual(["--harness"]);
    expect(spec["--harness"]?.kind).toBe("value");
  });

  test("--harness assigns the raw string", () => {
    const spec = harnessArg<HarnessArg>();
    const acc: HarnessArg = {};
    spec["--harness"]?.assign(acc, "claude");
    expect(acc.harness).toBe("claude");
  });
});

describe("harnessesArg", () => {
  test("declares both --harness and --harnesses entries", () => {
    const spec = harnessesArg<HarnessesArg>();
    expect(Object.keys(spec).sort()).toEqual(["--harness", "--harnesses"]);
    expect(spec["--harness"]?.kind).toBe("value");
    expect(spec["--harnesses"]?.kind).toBe("value");
  });

  test("--harness pushes onto the harnesses list, preserving order", () => {
    const spec = harnessesArg<HarnessesArg>();
    const acc: HarnessesArg = {};
    spec["--harness"]?.assign(acc, "opencode");
    spec["--harness"]?.assign(acc, "gemini");
    expect(acc.harnesses).toEqual(["opencode", "gemini"]);
  });

  test("--harnesses x,y splits on commas and trims whitespace", () => {
    const spec = harnessesArg<HarnessesArg>();
    const acc: HarnessesArg = {};
    spec["--harnesses"]?.assign(acc, " opencode , gemini , codex ");
    expect(acc.harnesses).toEqual(["opencode", "gemini", "codex"]);
  });

  test("--harnesses ignores empty entries from leading/trailing commas", () => {
    const spec = harnessesArg<HarnessesArg>();
    const acc: HarnessesArg = {};
    spec["--harnesses"]?.assign(acc, ",opencode,,gemini,");
    expect(acc.harnesses).toEqual(["opencode", "gemini"]);
  });

  test("mixed --harness and --harnesses forms preserve argv order", () => {
    const spec = harnessesArg<HarnessesArg>();
    const acc: HarnessesArg = {};
    spec["--harnesses"]?.assign(acc, "a,b");
    spec["--harness"]?.assign(acc, "c");
    spec["--harnesses"]?.assign(acc, "d,e");
    expect(acc.harnesses).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("single --harness invocation produces a 1-element list (back-compat path)", () => {
    const spec = harnessesArg<HarnessesArg>();
    const acc: HarnessesArg = {};
    spec["--harness"]?.assign(acc, "opencode");
    expect(acc.harnesses).toEqual(["opencode"]);
  });
});

describe("registrySyncArg", () => {
  test("declares --registry-sync as a flag", () => {
    const spec = registrySyncArg<RegistrySyncArg>();
    expect(Object.keys(spec)).toEqual(["--registry-sync"]);
    expect(spec["--registry-sync"]?.kind).toBe("flag");
  });

  test("--registry-sync flips the boolean knob to true", () => {
    const spec = registrySyncArg<RegistrySyncArg>();
    const acc: RegistrySyncArg = {};
    const entry = spec["--registry-sync"];
    if (entry?.kind !== "flag") throw new Error("expected flag entry");
    entry.assign(acc);
    expect(acc.registrySync).toBe(true);
  });

  test("default state leaves the knob undefined (sync stays off)", () => {
    const acc: RegistrySyncArg = {};
    expect(acc.registrySync).toBeUndefined();
  });
});

describe("runtimeSelectArgs", () => {
  test("composes harness with the full runtime-selection flag set", () => {
    const spec = runtimeSelectArgs<RuntimeSelectArgs>();
    expect(Object.keys(spec).sort()).toEqual([
      "--acp-args-json",
      "--acp-command",
      "--harness",
      "--profile",
    ]);
    expect(spec["--harness"]?.kind).toBe("value");
    expect(spec["--acp-command"]?.kind).toBe("value");
    expect(spec["--acp-args-json"]?.kind).toBe("value");
    expect(spec["--profile"]?.kind).toBe("value");
  });
});

/**
 * Each `ArgEntry` may carry an optional `description` and (for value
 * entries) an optional `valueExample`. Both feed
 * `docs/_generated/cli-command-table.md` directly. These pin the
 * representative shape so the partial generator's contract holds.
 */
describe("ArgEntry description + valueExample contract", () => {
  test("hostPortArgs entries carry a non-empty description and a valueExample", () => {
    const spec = hostPortArgs<HostPortArgs>();
    const port = spec["--port"];
    if (port?.kind !== "value") throw new Error("expected --port to be a value entry");
    expect(typeof port.description).toBe("string");
    expect(port.description?.length ?? 0).toBeGreaterThan(0);
    expect(typeof port.valueExample).toBe("string");
    expect(port.valueExample?.length ?? 0).toBeGreaterThan(0);
  });

  test("runtimeLogArgs --runtime-log-level carries a description with the level set", () => {
    const spec = runtimeLogArgs<RuntimeLogArgs>();
    const level = spec["--runtime-log-level"];
    if (level?.kind !== "value")
      throw new Error("expected --runtime-log-level to be a value entry");
    expect(level.description).toContain("debug");
    expect(level.description).toContain("silent");
  });

  test("harnessArg --harness carries a non-empty description", () => {
    const spec = harnessArg<HarnessArg>();
    const h = spec["--harness"];
    if (h?.kind !== "value") throw new Error("expected --harness to be a value entry");
    expect(typeof h.description).toBe("string");
    expect(h.description?.length ?? 0).toBeGreaterThan(0);
  });
});

/**
 * Per-subcommand `ARG_SPEC` constants are the inputs the
 * `cli-command-table.md` partial generator walks. The shared-fragment
 * tests above already pin the spread sources; these tests pin the
 * load-bearing local entries plus a representative spread-derived entry
 * per subcommand so a refactor that drops a description (or breaks a
 * spread chain so descriptions are lost on assembly) fails here.
 */
describe("ACP_ARG_SPEC (acp subcommand)", () => {
  test("--directory describes its constraint and exposes a path valueExample", () => {
    const dir = ACP_ARG_SPEC["--directory"];
    if (dir?.kind !== "value") throw new Error("expected --directory to be a value entry");
    expect(dir.description).toMatch(/workspace directory/);
    expect(dir.valueExample).toBe("<path>");
  });

  test("composes runtimeSelectArgs so --harness retains its description", () => {
    const harness = ACP_ARG_SPEC["--harness"];
    if (harness?.kind !== "value") throw new Error("expected --harness to be a value entry");
    expect(harness.description?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("BRIDGE_ARG_SPEC (bridge subcommand)", () => {
  test("composes hostPortArgs so --host and --port retain their descriptions", () => {
    const host = BRIDGE_ARG_SPEC["--host"];
    const port = BRIDGE_ARG_SPEC["--port"];
    if (host?.kind !== "value") throw new Error("expected --host to be a value entry");
    if (port?.kind !== "value") throw new Error("expected --port to be a value entry");
    expect(host.description?.length ?? 0).toBeGreaterThan(0);
    expect(port.description?.length ?? 0).toBeGreaterThan(0);
    expect(port.valueExample?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("SERVE_ARG_SPEC (serve subcommand)", () => {
  test("composes hostPortArgs + runtimeSelectArgs with descriptions intact", () => {
    const host = SERVE_ARG_SPEC["--host"];
    const harness = SERVE_ARG_SPEC["--harness"];
    if (host?.kind !== "value") throw new Error("expected --host to be a value entry");
    if (harness?.kind !== "value") throw new Error("expected --harness to be a value entry");
    expect(host.description?.length ?? 0).toBeGreaterThan(0);
    expect(harness.description?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("MCP_SETUP_ARG_SPEC (mcp setup subcommand)", () => {
  test("--global is marked deprecated/removed next release (A2 — one-release window)", () => {
    // Per Jens design critique: --global named a Claude-specific behavior in a
    // vendor-neutral CLI. Silently broken since initial commit (wrote to a no-op
    // file). A2 resolution: parse the flag for one release, emit explicit
    // removal error + replacement pointers; full removal next release.
    const global = MCP_SETUP_ARG_SPEC["--global"];
    if (global?.kind !== "flag") throw new Error("expected --global to be a flag entry");
    expect(global.description).toMatch(/deprecated|removed/i);
  });

  test("--claude describes the claude mcp add registration path", () => {
    const claude = MCP_SETUP_ARG_SPEC["--claude"];
    if (claude?.kind !== "flag") throw new Error("expected --claude to be a flag entry");
    expect(claude.description).toMatch(/claude mcp add/);
  });
});

describe("MCP_BRIDGE_ARG_SPEC (mcp bridge subcommand)", () => {
  test("--url describes the gateway base URL with a valueExample", () => {
    const url = MCP_BRIDGE_ARG_SPEC["--url"];
    if (url?.kind !== "value") throw new Error("expected --url to be a value entry");
    expect(url.description).toMatch(/gateway/i);
    expect(url.valueExample).toBe("<gateway-url>");
  });
});

describe("SEND_ARG_SPEC (send subcommand)", () => {
  test("--url describes the serve base URL fallback with a valueExample", () => {
    const url = SEND_ARG_SPEC["--url"];
    if (url?.kind !== "value") throw new Error("expected --url to be a value entry");
    expect(url.description).toMatch(/serve base URL/);
    expect(url.valueExample).toBe("<base-url>");
  });

  test("--harness describes the routing contract with a valueExample", () => {
    const harness = SEND_ARG_SPEC["--harness"];
    if (harness?.kind !== "value") throw new Error("expected --harness to be a value entry");
    expect(harness.description).toMatch(/harness id/);
    expect(harness.valueExample).toBe("<id>");
  });

  test("--raw describes the streaming behavior", () => {
    const raw = SEND_ARG_SPEC["--raw"];
    if (raw?.kind !== "flag") throw new Error("expected --raw to be a flag entry");
    expect(raw.description).toMatch(/message\.delta/);
  });
});
