#!/usr/bin/env bun

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

interface PortainerStack {
  Env?: PortainerStackEnvVar[];
  Id: number;
  Name: string;
}

interface PortainerContainer {
  Image: string;
  Names?: string[];
  State?: string;
  Status?: string;
}

interface PortainerStackEnvVar {
  name: string;
  value: string;
}

interface PortainerRequestOptions {
  apiKey: string;
  body?: unknown;
  insecureTls?: boolean;
  method?: "GET" | "PUT";
  path: string;
  portainerUrl: string;
}

interface PortainerResponse {
  body: string;
  statusCode: number;
}

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dir, "..");

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function parseBooleanFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return /^(1|true|yes|on)$/i.test(value.trim());
}

export function mergeStackEnv(
  existing: PortainerStackEnvVar[] | undefined,
  desired: PortainerStackEnvVar[],
): PortainerStackEnvVar[] {
  const merged = new Map<string, string>();

  for (const entry of existing ?? []) {
    if (entry?.name) {
      merged.set(entry.name, entry.value ?? "");
    }
  }

  for (const entry of desired) {
    merged.set(entry.name, entry.value);
  }

  return [...merged.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ name, value }));
}

export function buildPortainerCurlArgs(options: PortainerRequestOptions): string[] {
  const args = [
    "-sS",
    "-X",
    options.method ?? "GET",
    "-H",
    `X-API-Key: ${options.apiKey}`,
    "-H",
    "Accept: application/json",
  ];

  if (options.insecureTls) {
    args.push("-k");
  }

  if (options.body !== undefined) {
    args.push("-H", "Content-Type: application/json", "--data-raw", JSON.stringify(options.body));
  }

  args.push("-w", "\n%{http_code}", `${options.portainerUrl}${options.path}`);
  return args;
}

export function parseCurlHttpResponse(stdout: string): PortainerResponse {
  const match = stdout.match(/^(?<body>[\s\S]*)\n(?<status>\d{3})$/);
  if (!match?.groups) {
    throw new Error(`Could not parse curl response status from output: ${stdout}`);
  }

  return {
    body: match.groups.body,
    statusCode: Number.parseInt(match.groups.status, 10),
  };
}

export function findContainerByName(
  containers: PortainerContainer[],
  containerName: string,
): PortainerContainer | undefined {
  const expectedName = containerName.startsWith("/") ? containerName : `/${containerName}`;
  return containers.find((container) => (container.Names ?? []).includes(expectedName));
}

async function portainerRequest(options: PortainerRequestOptions): Promise<PortainerResponse> {
  try {
    const { stdout, stderr } = await execFileAsync("curl", buildPortainerCurlArgs(options), {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    const response = parseCurlHttpResponse(stdout);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const detail = [response.body.trim(), stderr.trim()].filter(Boolean).join("\n");
      throw new Error(
        `Portainer request failed (${response.statusCode}) for ${options.path}${detail ? `:\n${detail}` : ""}`,
      );
    }
    return response;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Portainer curl request failed for ${options.path}: ${error.message}`);
    }
    throw error;
  }
}

async function readJson<T>(options: PortainerRequestOptions): Promise<T> {
  const response = await portainerRequest(options);
  return JSON.parse(response.body) as T;
}

async function updateStack(options: PortainerRequestOptions): Promise<void> {
  await portainerRequest({ ...options, method: "PUT" });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForContainerState(options: {
  apiKey: string;
  containerName: string;
  endpointId: string;
  expectedImage?: string;
  insecureTls?: boolean;
  portainerUrl: string;
  timeoutMs?: number;
}): Promise<PortainerContainer> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  let lastFailure = `Container "${options.containerName}" was not found.`;

  while (Date.now() <= deadline) {
    const containers = await readJson<PortainerContainer[]>({
      apiKey: options.apiKey,
      insecureTls: options.insecureTls,
      path: `/api/endpoints/${encodeURIComponent(options.endpointId)}/docker/containers/json?all=true`,
      portainerUrl: options.portainerUrl,
    });

    const container = findContainerByName(containers, options.containerName);
    if (!container) {
      lastFailure = `Container "${options.containerName}" was not found.`;
    } else if (options.expectedImage && container.Image !== options.expectedImage) {
      lastFailure = `Container "${options.containerName}" is using ${container.Image} instead of ${options.expectedImage}.`;
    } else if (container.State !== "running") {
      lastFailure = `Container "${options.containerName}" is ${container.State ?? "unknown"} (${container.Status ?? "no status"}).`;
    } else {
      return container;
    }

    await sleep(2_000);
  }

  throw new Error(lastFailure);
}

async function main(): Promise<void> {
  const apiKey = requireEnv("PORTAINER_API_KEY");
  const endpointId = requireEnv("PORTAINER_ENDPOINT_ID");
  const cloudflaredToken = requireEnv("CLOUDFLARED_TOKEN");
  const docsImage = requireEnv("DOCS_IMAGE");

  const portainerUrl = requireEnv("PORTAINER_URL");
  const insecureTls = parseBooleanFlag(process.env.PORTAINER_INSECURE_TLS);
  const stackName = process.env.PORTAINER_STACK_NAME?.trim() || "agents-js-docs";
  const stackFilePath = path.resolve(
    repoRoot,
    process.env.DOCS_STACK_FILE ?? "deploy/docs.compose.yaml",
  );

  const docsHostname = process.env.DOCS_HOSTNAME?.trim() || "localhost";
  const docsPublishedPort = process.env.DOCS_PUBLISHED_PORT?.trim() || "5180";
  const docsBindAddress = process.env.DOCS_BIND_ADDRESS?.trim() || "127.0.0.1";
  const docsContainerName = process.env.DOCS_CONTAINER_NAME?.trim() || "agents-js-docs";
  const docsTunnelContainerName =
    process.env.DOCS_TUNNEL_CONTAINER_NAME?.trim() || "agents-js-docs-tunnel";
  const docsTunnelImage = process.env.DOCS_TUNNEL_IMAGE?.trim() || "cloudflare/cloudflared:latest";

  const stacks = await readJson<PortainerStack[]>({
    apiKey,
    insecureTls,
    path: "/api/stacks",
    portainerUrl,
  });
  const stack = stacks.find((entry) => entry.Name === stackName);

  if (!stack) {
    throw new Error(
      `Portainer stack "${stackName}" was not found for update. The checked-in deploy lane expects the existing stack defined by ${path.relative(
        repoRoot,
        stackFilePath,
      )}.`,
    );
  }

  const currentStack = await readJson<PortainerStack>({
    apiKey,
    insecureTls,
    path: `/api/stacks/${stack.Id}`,
    portainerUrl,
  });
  const stackFileContent = await readFile(stackFilePath, "utf8");
  const env = mergeStackEnv(currentStack.Env, [
    { name: "CLOUDFLARED_TOKEN", value: cloudflaredToken },
    { name: "DOCS_BIND_ADDRESS", value: docsBindAddress },
    { name: "DOCS_CONTAINER_NAME", value: docsContainerName },
    { name: "DOCS_HOSTNAME", value: docsHostname },
    { name: "DOCS_IMAGE", value: docsImage },
    { name: "DOCS_PUBLISHED_PORT", value: docsPublishedPort },
    { name: "DOCS_TUNNEL_CONTAINER_NAME", value: docsTunnelContainerName },
    { name: "DOCS_TUNNEL_IMAGE", value: docsTunnelImage },
  ]);

  await updateStack({
    apiKey,
    body: {
      Env: env,
      Prune: true,
      PullImage: true,
      StackFileContent: stackFileContent,
    },
    insecureTls,
    method: "PUT",
    path: `/api/stacks/${stack.Id}?endpointId=${encodeURIComponent(endpointId)}`,
    portainerUrl,
  });

  const container = await waitForContainerState({
    apiKey,
    containerName: docsContainerName,
    endpointId,
    expectedImage: docsImage,
    insecureTls,
    portainerUrl,
  });
  const tunnelContainer = await waitForContainerState({
    apiKey,
    containerName: docsTunnelContainerName,
    endpointId,
    expectedImage: docsTunnelImage,
    insecureTls,
    portainerUrl,
  });

  console.log(
    JSON.stringify(
      {
        containerImage: container.Image,
        containerName: (container.Names ?? [docsContainerName])[0],
        containerState: container.State ?? "unknown",
        containerStatus: container.Status ?? "unknown",
        docsHostname,
        docsImage,
        endpointId,
        insecureTls,
        portainerUrl,
        publishedPort: docsPublishedPort,
        stackId: stack.Id,
        stackName,
        tunnelContainerImage: tunnelContainer.Image,
        tunnelContainerName: (tunnelContainer.Names ?? [docsTunnelContainerName])[0],
        tunnelContainerState: tunnelContainer.State ?? "unknown",
        tunnelContainerStatus: tunnelContainer.Status ?? "unknown",
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  await main();
}
