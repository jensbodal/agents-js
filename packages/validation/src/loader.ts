import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ValidationError } from "./errors.ts";

export type JsonSource = unknown | string | URL;

function parseJsonString(text: string, sourceLabel: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ValidationError(`Source is not valid JSON: ${sourceLabel}`, {
      field: "source",
      value: sourceLabel,
      issues: [
        {
          path: "source",
          message: error instanceof Error ? error.message : "JSON parse failed",
        },
      ],
    });
  }
}

async function loadJsonFromUrl(url: URL): Promise<unknown> {
  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new ValidationError(`Failed to load JSON from URL (HTTP ${response.status})`, {
      field: "source",
      value: url.toString(),
      issues: [{ path: "source", message: `HTTP ${response.status}` }],
    });
  }

  const body = await response.text();
  return parseJsonString(body, url.toString());
}

async function loadJsonFromPath(path: string): Promise<unknown> {
  try {
    const content = await readFile(path, "utf8");
    return parseJsonString(content, path);
  } catch (error) {
    throw new ValidationError(`Failed to load JSON file: ${path}`, {
      field: "source",
      value: path,
      issues: [
        {
          path: "source",
          message: error instanceof Error ? error.message : "Unable to read file",
        },
      ],
    });
  }
}

function tryParseHttpUrl(value: string): URL | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed;
    }
  } catch {
    // not a URL; treat as local path
  }

  return undefined;
}

export async function loadJsonFromSource(source: JsonSource): Promise<unknown> {
  if (source instanceof URL) {
    if (source.protocol === "http:" || source.protocol === "https:") {
      return loadJsonFromUrl(source);
    }

    if (source.protocol === "file:") {
      return loadJsonFromPath(fileURLToPath(source));
    }

    throw new ValidationError(`Unsupported URL protocol: ${source.protocol}`, {
      field: "source",
      value: source.toString(),
      issues: [{ path: "source", message: "Only http(s) and file URLs are supported" }],
    });
  }

  if (typeof source === "string") {
    const url = tryParseHttpUrl(source);
    if (url) {
      return loadJsonFromUrl(url);
    }

    return loadJsonFromPath(source);
  }

  if (typeof source === "object" && source !== null) {
    return source;
  }

  throw new ValidationError("source must be an object, URL, or file path", {
    field: "source",
    value: source,
    issues: [{ path: "source", message: "Invalid source type" }],
  });
}
