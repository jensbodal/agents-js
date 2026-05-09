import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { acpGeneratedSchemaArtifacts } from "../src/generated/acp-schema.ts";

function findDiscriminatedBranch(
  branches: Array<Record<string, unknown>>,
  discriminatorProperty: string,
  discriminatorValue: string,
): Record<string, unknown> {
  const branch = branches.find((candidate) => {
    const properties =
      candidate.properties && typeof candidate.properties === "object"
        ? (candidate.properties as Record<string, unknown>)
        : undefined;
    const discriminator =
      properties?.[discriminatorProperty] && typeof properties[discriminatorProperty] === "object"
        ? (properties[discriminatorProperty] as Record<string, unknown>)
        : undefined;
    return discriminator?.const === discriminatorValue;
  });

  if (!branch) {
    throw new Error(
      `missing ${discriminatorProperty}=${discriminatorValue} branch in generated ACP schema`,
    );
  }

  return branch;
}

describe("generated ACP schema artifacts", () => {
  test("keep extension pockets open while closing strict request objects", () => {
    const strictCloseSessionRequest =
      acpGeneratedSchemaArtifacts.strictDocument.$defs.CloseSessionRequest;
    const looseCloseSessionRequest =
      acpGeneratedSchemaArtifacts.looseDocument.$defs.CloseSessionRequest;

    expect(strictCloseSessionRequest).toMatchObject({
      additionalProperties: false,
      properties: {
        _meta: {
          additionalProperties: true,
        },
      },
    });
    expect(looseCloseSessionRequest).not.toHaveProperty("additionalProperties");
  });

  test("encode discriminated unions as closed strict branches", () => {
    const strictSessionConfigOption =
      acpGeneratedSchemaArtifacts.strictDocument.$defs.SessionConfigOption;

    expect(strictSessionConfigOption).toMatchObject({
      discriminator: {
        propertyName: "type",
      },
    });

    const strictBranches = strictSessionConfigOption.oneOf as ReadonlyArray<
      Record<string, unknown>
    >;
    for (const branch of strictBranches) {
      expect(branch.additionalProperties).toBe(false);
      expect(branch.properties).toHaveProperty("type");
      expect(branch.properties).toHaveProperty("id");
      expect(branch.properties).toHaveProperty("name");
    }
  });

  test("normalize nested request compositions for session/update notifications", () => {
    const strictSessionNotification =
      acpGeneratedSchemaArtifacts.strictDocument.$defs.SessionNotification;
    const updateSchema = strictSessionNotification.properties.update as Record<string, unknown>;
    const updateBranches = updateSchema.oneOf as Array<Record<string, unknown>>;
    const availableCommandsBranch = findDiscriminatedBranch(
      updateBranches,
      "sessionUpdate",
      "available_commands_update",
    );

    expect(strictSessionNotification).toMatchObject({
      additionalProperties: false,
      properties: {
        _meta: {
          additionalProperties: true,
        },
      },
    });
    expect(updateSchema).toMatchObject({
      discriminator: {
        propertyName: "sessionUpdate",
      },
    });
    expect(availableCommandsBranch.additionalProperties).toBe(false);
    expect(availableCommandsBranch.properties).toHaveProperty("availableCommands");
    expect(availableCommandsBranch.properties).toHaveProperty("sessionUpdate");
  });

  test("normalize nested response compositions for initialize responses", () => {
    const strictInitializeResponse =
      acpGeneratedSchemaArtifacts.strictDocument.$defs.InitializeResponse;
    const agentCapabilities = strictInitializeResponse.properties.agentCapabilities as Record<
      string,
      unknown
    >;
    const sessionCapabilities = (agentCapabilities.properties as Record<string, unknown>)
      .sessionCapabilities as Record<string, unknown>;

    expect(strictInitializeResponse).toMatchObject({
      additionalProperties: false,
      properties: {
        _meta: {
          additionalProperties: true,
        },
      },
    });
    expect(agentCapabilities.additionalProperties).toBe(false);
    expect((agentCapabilities.properties as Record<string, unknown>)._meta).toMatchObject({
      additionalProperties: true,
    });
    expect(sessionCapabilities.additionalProperties).toBe(false);
    expect(sessionCapabilities.properties).toHaveProperty("close");
    expect(sessionCapabilities.properties).toHaveProperty("list");
  });

  test("checked-in ACP artifacts are up to date", () => {
    const bunBinary = Bun.which("bun") ?? "bun";
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const generatorPath = fileURLToPath(
      new URL("../scripts/generate-acp-schema.ts", import.meta.url),
    );
    const command = Bun.spawnSync({
      cmd: [bunBinary, generatorPath, "--check"],
      cwd: packageRoot,
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(command.exitCode).toBe(0);
  });
});
