import { describe, expect, it } from "bun:test";
import {
  createManifestValidator,
  DEFAULT_MANIFEST,
  type ManifestDraft,
  renderManifestAsYaml,
} from "./manifest-schema.ts";

describe("createManifestValidator", () => {
  const validate = createManifestValidator();

  it("accepts the default manifest", () => {
    const r = validate(DEFAULT_MANIFEST);
    expect(r.valid).toBe(true);
    expect(r.errors).toBeUndefined();
  });

  it("accepts a fully populated valid manifest", () => {
    const draft: ManifestDraft = {
      name: "docs-meta-agent",
      runtime: "local-wasm-worker",
      permissions: "explicit",
      tools: [
        { name: "searchDocs", allow: true },
        { name: "fetchUrl", allow: false },
      ],
    };
    const r = validate(draft);
    expect(r.valid).toBe(true);
  });

  it("accepts the mock runtime id", () => {
    const r = validate({
      name: "x",
      runtime: "mock",
      permissions: "explicit",
      tools: [],
    } satisfies ManifestDraft);
    expect(r.valid).toBe(true);
  });

  it("accepts the agents-js-gateway runtime id (reserved for M5+, no adapter yet)", () => {
    // Schema-level validity is independent of adapter availability — the
    // manifest editor disables this option in the form, but a hand-written
    // manifest with `runtime: "agents-js-gateway"` must still validate so
    // that future-shape manifests don't get rejected mid-migration.
    const r = validate({
      name: "x",
      runtime: "agents-js-gateway",
      permissions: "explicit",
      tools: [],
    } satisfies ManifestDraft);
    expect(r.valid).toBe(true);
  });

  it("rejects an unknown runtime id", () => {
    const r = validate({
      name: "x",
      runtime: "remote-mystery",
      permissions: "explicit",
      tools: [],
    });
    expect(r.valid).toBe(false);
    expect(r.errors?.length).toBeGreaterThan(0);
  });

  it("rejects an unknown permissions enum value", () => {
    const r = validate({
      name: "x",
      runtime: "local-wasm-worker",
      permissions: "ask-the-user-twice",
      tools: [],
    });
    expect(r.valid).toBe(false);
  });

  it("rejects empty name", () => {
    const r = validate({
      name: "",
      runtime: "local-wasm-worker",
      permissions: "explicit",
      tools: [],
    });
    expect(r.valid).toBe(false);
  });

  it("rejects manifest missing tools", () => {
    const r = validate({
      name: "x",
      runtime: "local-wasm-worker",
      permissions: "explicit",
    });
    expect(r.valid).toBe(false);
  });

  it("rejects a tool with empty name", () => {
    const r = validate({
      name: "x",
      runtime: "local-wasm-worker",
      permissions: "explicit",
      tools: [{ name: "" }],
    });
    expect(r.valid).toBe(false);
  });

  it("rejects entirely non-object input", () => {
    const r = validate(42);
    expect(r.valid).toBe(false);
  });

  it("rejects unknown top-level fields (additionalProperties)", () => {
    const r = validate({
      name: "x",
      runtime: "local-wasm-worker",
      permissions: "explicit",
      tools: [],
      evilSidecar: true,
    });
    expect(r.valid).toBe(false);
  });
});

describe("renderManifestAsYaml", () => {
  const draft: ManifestDraft = {
    name: "docs-meta-agent",
    runtime: "local-wasm-worker",
    permissions: "plan",
    tools: [{ name: "searchDocs", allow: true }, { name: "fetchUrl" }],
  };

  it("emits all four fields in stable order", () => {
    const yaml = renderManifestAsYaml(draft);
    expect(yaml).toContain("name: docs-meta-agent");
    expect(yaml).toContain("runtime: local-wasm-worker");
    expect(yaml).toContain("permissions: plan");
    expect(yaml).toContain("tools:");
    // Order: name first, then runtime, then permissions, then tools.
    const nameIdx = yaml.indexOf("name:");
    const runtimeIdx = yaml.indexOf("runtime:");
    const permsIdx = yaml.indexOf("permissions:");
    const toolsIdx = yaml.indexOf("tools:");
    expect(nameIdx).toBeLessThan(runtimeIdx);
    expect(runtimeIdx).toBeLessThan(permsIdx);
    expect(permsIdx).toBeLessThan(toolsIdx);
  });

  it("renders each tool as a list item with name and allow flag", () => {
    const yaml = renderManifestAsYaml(draft);
    expect(yaml).toContain("- name: searchDocs");
    expect(yaml).toContain("allow: true");
    expect(yaml).toContain("- name: fetchUrl");
  });

  it("omits the allow line when undefined", () => {
    const yaml = renderManifestAsYaml({
      name: "x",
      runtime: "local-wasm-worker",
      permissions: "explicit",
      tools: [{ name: "onlyName" }],
    });
    // The fetchUrl tool in this fixture has no allow key.
    const lines = yaml.split("\n");
    const fetchLine = lines.findIndex((l) => l.includes("- name: onlyName"));
    expect(fetchLine).toBeGreaterThanOrEqual(0);
    const nextLine = lines[fetchLine + 1] ?? "";
    expect(nextLine.includes("allow:")).toBe(false);
  });

  it("renders an empty tools list as `tools: []`", () => {
    const yaml = renderManifestAsYaml({
      name: "x",
      runtime: "local-wasm-worker",
      permissions: "explicit",
      tools: [],
    });
    expect(yaml).toContain("tools: []");
  });

  it("is deterministic for the same input", () => {
    expect(renderManifestAsYaml(draft)).toBe(renderManifestAsYaml(draft));
  });
});

describe("DEFAULT_MANIFEST", () => {
  it("has all required fields populated", () => {
    expect(DEFAULT_MANIFEST.name.length).toBeGreaterThan(0);
    expect(DEFAULT_MANIFEST.runtime).toBeDefined();
    expect(DEFAULT_MANIFEST.permissions).toBeDefined();
    expect(Array.isArray(DEFAULT_MANIFEST.tools)).toBe(true);
  });
});
