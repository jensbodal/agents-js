export type RuntimeE2EFailureClassification =
  | "runtime-availability-config-problem"
  | "acp-contamination-problem"
  | "gateway-a2a-contract-problem";

export type RuntimeE2EFailureCode =
  | "missing_runtime_argument"
  | "unsupported_runtime"
  | "missing_profile_argument"
  | "invalid_profile_name"
  | "runtime_profile_missing"
  | "runtime_profile_mismatch"
  | "acp_stdout_contamination"
  | "gateway_a2a_contract_failure"
  | "unexpected_failure";

export type RuntimeE2EResultContract = {
  classification: RuntimeE2EFailureClassification | "passed";
  contractVersion: 1;
  failureCode: RuntimeE2EFailureCode | null;
  failureMessage: string | null;
  passed: boolean;
  profile: string | null;
  runtime: string;
};

export type RuntimeE2EResultParse =
  | {
      result: RuntimeE2EResultContract;
      status: "ok";
    }
  | {
      status: "malformed";
      value: string;
    }
  | {
      status: "missing";
    };

export const runtimeE2EResultPrefix = "[runtime-e2e:result]";

const runtimeE2EProofMarkers = {
  runtimeBoot: "[runtime-e2e] runtime boot: ok",
  contaminationCheck: "[runtime-e2e] contamination check: clean",
  sessionBootstrap: "[runtime-e2e] session bootstrap: ok",
  promptRoundTrip: "[runtime-e2e] prompt round-trip: ok",
  baseUrlFlow: "[runtime-e2e] base-url flow: ok",
  cardUrlFlow: "[runtime-e2e] card-url flow: ok",
  streamingCapability: "[runtime-e2e] streaming: validated via capability flag",
} as const;

export type RuntimeE2EProofChecks = {
  runtimeBoot: boolean;
  contaminationCheck: boolean;
  sessionBootstrap: boolean;
  promptRoundTrip: boolean;
  baseUrlFlow: boolean;
  cardUrlFlow: boolean;
  streamingCapability: boolean;
};

export function formatRuntimeE2EResult(result: RuntimeE2EResultContract): string {
  return `${runtimeE2EResultPrefix} ${JSON.stringify(result)}`;
}

export function extractRuntimeE2EProofChecks(output: string): RuntimeE2EProofChecks {
  return {
    runtimeBoot: output.includes(runtimeE2EProofMarkers.runtimeBoot),
    contaminationCheck: output.includes(runtimeE2EProofMarkers.contaminationCheck),
    sessionBootstrap: output.includes(runtimeE2EProofMarkers.sessionBootstrap),
    promptRoundTrip: output.includes(runtimeE2EProofMarkers.promptRoundTrip),
    baseUrlFlow: output.includes(runtimeE2EProofMarkers.baseUrlFlow),
    cardUrlFlow: output.includes(runtimeE2EProofMarkers.cardUrlFlow),
    streamingCapability: output.includes(runtimeE2EProofMarkers.streamingCapability),
  };
}

export function parseRuntimeE2EResultLine(line: string): RuntimeE2EResultParse {
  const trimmed = line.trim();
  if (!trimmed.startsWith(runtimeE2EResultPrefix)) {
    return { status: "missing" };
  }

  const value = trimmed.slice(runtimeE2EResultPrefix.length).trim();
  if (!value) {
    return { status: "malformed", value };
  }

  try {
    const parsed = JSON.parse(value) as Partial<RuntimeE2EResultContract>;
    if (
      parsed.contractVersion !== 1 ||
      typeof parsed.runtime !== "string" ||
      typeof parsed.passed !== "boolean" ||
      (parsed.profile !== null && typeof parsed.profile !== "string") ||
      (parsed.failureCode !== null &&
        parsed.failureCode !== undefined &&
        typeof parsed.failureCode !== "string") ||
      (parsed.failureMessage !== null &&
        parsed.failureMessage !== undefined &&
        typeof parsed.failureMessage !== "string") ||
      typeof parsed.classification !== "string"
    ) {
      return { status: "malformed", value };
    }

    return {
      status: "ok",
      result: {
        classification: parsed.classification,
        contractVersion: 1,
        failureCode: parsed.failureCode ?? null,
        failureMessage: parsed.failureMessage ?? null,
        passed: parsed.passed,
        profile: parsed.profile ?? null,
        runtime: parsed.runtime,
      },
    };
  } catch {
    return { status: "malformed", value };
  }
}

export function extractRuntimeE2EResult(output: string): RuntimeE2EResultParse {
  const lines = output.split(/\r?\n/).reverse();
  for (const line of lines) {
    const parsed = parseRuntimeE2EResultLine(line);
    if (parsed.status !== "missing") {
      return parsed;
    }
  }

  return { status: "missing" };
}
