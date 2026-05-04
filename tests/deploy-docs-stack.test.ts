import { describe, expect, test } from "bun:test";
import {
  buildPortainerCurlArgs,
  findContainerByName,
  mergeStackEnv,
  parseBooleanFlag,
  parseCurlHttpResponse,
} from "../scripts/deploy-docs-stack.ts";

describe("deploy-docs-stack helpers", () => {
  test("buildPortainerCurlArgs adds -k only when insecure TLS is enabled", () => {
    const secureArgs = buildPortainerCurlArgs({
      apiKey: "token",
      path: "/api/stacks",
      portainerUrl: "https://docker.tail019e7.ts.net:9443",
    });
    const insecureArgs = buildPortainerCurlArgs({
      apiKey: "token",
      insecureTls: true,
      path: "/api/stacks",
      portainerUrl: "https://docker.tail019e7.ts.net:9443",
    });

    expect(secureArgs).not.toContain("-k");
    expect(insecureArgs).toContain("-k");
  });

  test("parseCurlHttpResponse extracts the trailing status code", () => {
    expect(parseCurlHttpResponse('{"ok":true}\n200')).toEqual({
      body: '{"ok":true}',
      statusCode: 200,
    });
  });

  test("findContainerByName matches the docker-style slash-prefixed name", () => {
    const container = findContainerByName(
      [
        {
          Image: "gitea.tail019e7.ts.net/jensbodal/agents-js/docs:latest",
          Names: ["/agents-js-docs"],
          State: "running",
        },
      ],
      "agents-js-docs",
    );

    expect(container?.Names).toEqual(["/agents-js-docs"]);
  });

  test("findContainerByName can match the tunnel sidecar by explicit container name", () => {
    const container = findContainerByName(
      [
        {
          Image: "cloudflare/cloudflared:latest",
          Names: ["/agents-js-docs-tunnel"],
          State: "running",
        },
      ],
      "agents-js-docs-tunnel",
    );

    expect(container?.Image).toBe("cloudflare/cloudflared:latest");
  });

  test("mergeStackEnv preserves existing vars and overrides desired ones deterministically", () => {
    expect(
      mergeStackEnv(
        [
          { name: "CLOUDFLARED_TOKEN", value: "stale-token" },
          { name: "DOCS_IMAGE", value: "old" },
          { name: "UNRELATED", value: "keep-me" },
        ],
        [
          { name: "CLOUDFLARED_TOKEN", value: "new-token" },
          { name: "DOCS_IMAGE", value: "new" },
          { name: "DOCS_HOSTNAME", value: "agents-js.bodal.dev" },
        ],
      ),
    ).toEqual([
      { name: "CLOUDFLARED_TOKEN", value: "new-token" },
      { name: "DOCS_HOSTNAME", value: "agents-js.bodal.dev" },
      { name: "DOCS_IMAGE", value: "new" },
      { name: "UNRELATED", value: "keep-me" },
    ]);
  });

  test("parseBooleanFlag accepts the workflow-style enabled values", () => {
    expect(parseBooleanFlag("1")).toBe(true);
    expect(parseBooleanFlag("true")).toBe(true);
    expect(parseBooleanFlag("yes")).toBe(true);
    expect(parseBooleanFlag("0")).toBe(false);
    expect(parseBooleanFlag(undefined)).toBe(false);
  });
});
