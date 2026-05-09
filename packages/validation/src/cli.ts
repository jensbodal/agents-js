#!/usr/bin/env bun

import {
  type ACPMethod,
  isValidationMode,
  ValidationError,
  type ValidationMode,
  validateA2ARequest,
  validateA2AResponse,
  validateACPEnvelope,
  validateACPRequest,
  validateACPResponse,
  validateAgentCard,
  validateJsonRpcEnvelope,
  validateRuntimeManifest,
} from "./index.ts";
import { type JsonSource, loadJsonFromSource } from "./loader.ts";

type ValidationTarget =
  | "jsonrpc-request"
  | "jsonrpc-response"
  | "a2a-request"
  | "a2a-response"
  | "acp-envelope"
  | "acp-request"
  | "acp-response"
  | "agent-card"
  | "runtime-manifest";

const VALID_TARGETS: ReadonlySet<ValidationTarget> = new Set([
  "jsonrpc-request",
  "jsonrpc-response",
  "a2a-request",
  "a2a-response",
  "acp-envelope",
  "acp-request",
  "acp-response",
  "agent-card",
  "runtime-manifest",
]);

interface CliOptions {
  help?: boolean;
  method?: string;
  mode?: ValidationMode;
  runtime?: string;
  source?: string;
  target?: ValidationTarget;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--source") {
      options.source = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--target") {
      options.target = argv[i + 1] as ValidationTarget;
      i += 1;
      continue;
    }

    if (arg === "--runtime") {
      options.runtime = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--mode") {
      const mode = argv[i + 1];
      i += 1;

      if (!mode || !isValidationMode(mode)) {
        throw new ValidationError(`Unsupported validation mode: ${mode ?? "(missing)"}`, {
          field: "mode",
          value: mode,
          issues: [{ path: "mode", message: "Unsupported validation mode" }],
        });
      }

      options.mode = mode;
      continue;
    }

    if (arg === "--method") {
      options.method = argv[i + 1];
      i += 1;
      continue;
    }

    throw new ValidationError(`Unknown argument: ${arg}`, {
      field: "argv",
      value: arg,
      issues: [{ path: "argv", message: `Unknown argument: ${arg}` }],
    });
  }

  return options;
}

function usage(): string {
  return [
    "agents-validate --source <url|path> --target <jsonrpc-request|jsonrpc-response|a2a-request|a2a-response|acp-envelope|acp-request|acp-response|agent-card|runtime-manifest>",
    "Optional:",
    "  --mode <strict|loose|filter>  Validation mode (default: strict)",
    "  --method <acp-method>         Required when --target acp-response",
    "  --runtime <id>                Required when --target runtime-manifest",
    "  --help                        Show this message",
  ].join("\n");
}

function printJson(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof ValidationError) {
    return {
      ok: false,
      error: {
        name: error.name,
        message: error.message,
        field: error.field,
        issues: error.issues,
      },
    };
  }

  return {
    ok: false,
    error: {
      name: "Error",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function runTargetValidation(payload: unknown, options: CliOptions): unknown {
  switch (options.target) {
    case "jsonrpc-request": {
      return validateJsonRpcEnvelope(payload, "request", { mode: options.mode });
    }
    case "jsonrpc-response": {
      return validateJsonRpcEnvelope(payload, "response", { mode: options.mode });
    }
    case "a2a-request": {
      return validateA2ARequest(payload, { mode: options.mode });
    }
    case "a2a-response": {
      return validateA2AResponse(payload, { mode: options.mode });
    }
    case "acp-envelope": {
      return validateACPEnvelope(payload, { mode: options.mode });
    }
    case "acp-request": {
      return validateACPRequest(payload, { mode: options.mode });
    }
    case "acp-response": {
      if (!options.method) {
        throw new ValidationError("--method is required for acp-response validation", {
          field: "method",
          value: options.method,
          issues: [{ path: "method", message: "Missing ACP method" }],
        });
      }

      return validateACPResponse(payload, {
        method: options.method as ACPMethod,
        mode: options.mode,
      });
    }
    case "agent-card": {
      return validateAgentCard(payload, { mode: options.mode });
    }
    case "runtime-manifest": {
      if (!options.runtime) {
        throw new ValidationError("--runtime is required for runtime-manifest validation", {
          field: "runtime",
          value: options.runtime,
          issues: [{ path: "runtime", message: "Missing runtime identifier" }],
        });
      }

      return validateRuntimeManifest(payload, options.runtime, { mode: options.mode });
    }
    default: {
      throw new ValidationError(`Unsupported target: ${options.target ?? "(missing)"}`, {
        field: "target",
        value: options.target,
        issues: [{ path: "target", message: "Unsupported target" }],
      });
    }
  }
}

export async function runValidationCli(argv: string[]): Promise<number> {
  try {
    const options = parseArgs(argv);

    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }

    if (!options.source || !options.target) {
      throw new ValidationError("--source and --target are required", {
        field: "argv",
        value: argv,
        issues: [
          {
            path: "argv",
            message: "Missing required arguments",
          },
        ],
      });
    }

    if (!VALID_TARGETS.has(options.target)) {
      throw new ValidationError(`Unsupported target: ${options.target}`, {
        field: "target",
        value: options.target,
        issues: [{ path: "target", message: "Unsupported target" }],
      });
    }

    const source: JsonSource = options.source;
    const payload = await loadJsonFromSource(source);
    const validated = runTargetValidation(payload, options);

    printJson({
      ok: true,
      target: options.target,
      source: options.source,
      runtime: options.runtime,
      method: options.method,
      mode: options.mode ?? "strict",
      payload: validated,
    });
    return 0;
  } catch (error) {
    printJson(errorPayload(error));
    return 1;
  }
}

if (import.meta.main) {
  const exitCode = await runValidationCli(process.argv.slice(2));
  process.exit(exitCode);
}
