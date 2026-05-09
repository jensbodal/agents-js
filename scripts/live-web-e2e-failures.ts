export type LiveWebE2EFailureClassification =
  | "environment-contention"
  | "proof-surface"
  | "runtime-availability-config-problem";

export type LiveWebE2EFailureCode =
  | "launcher_port_contention"
  | "runtime_unavailable"
  | "missing_runtime_argument"
  | "launcher_discovery_timeout"
  | "launcher_exited_before_discovery"
  | "playwright_cli_unavailable"
  | "playwright_browser_install_failed"
  | "proof_surface_failure"
  | "unexpected_failure";

const classificationByCode: Record<LiveWebE2EFailureCode, LiveWebE2EFailureClassification> = {
  launcher_port_contention: "environment-contention",
  runtime_unavailable: "runtime-availability-config-problem",
  missing_runtime_argument: "runtime-availability-config-problem",
  launcher_discovery_timeout: "proof-surface",
  launcher_exited_before_discovery: "proof-surface",
  playwright_cli_unavailable: "proof-surface",
  playwright_browser_install_failed: "proof-surface",
  proof_surface_failure: "proof-surface",
  unexpected_failure: "proof-surface",
};

export class LiveWebE2EFailure extends Error {
  constructor(
    public readonly failureCode: LiveWebE2EFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LiveWebE2EFailure";
  }

  get classification(): LiveWebE2EFailureClassification {
    return classificationByCode[this.failureCode];
  }
}

export function createLiveWebE2EFailure(
  failureCode: LiveWebE2EFailureCode,
  message: string,
  options?: ErrorOptions,
): LiveWebE2EFailure {
  return new LiveWebE2EFailure(failureCode, message, options);
}

export function toLiveWebE2EFailure(error: unknown): LiveWebE2EFailure {
  if (error instanceof LiveWebE2EFailure) {
    return error;
  }

  return createLiveWebE2EFailure(
    "unexpected_failure",
    error instanceof Error ? error.message : String(error),
    error instanceof Error ? { cause: error } : undefined,
  );
}

export function detectLiveWebE2EFailureFromLine(line: string): LiveWebE2EFailure | null {
  if (/EADDRINUSE|address already in use|port \d+ is in use/i.test(line)) {
    return createLiveWebE2EFailure("launcher_port_contention", line);
  }

  if (
    line.includes('Unknown runtime "') ||
    line.includes("could not resolve executable") ||
    line.includes("Missing value for --runtime")
  ) {
    return createLiveWebE2EFailure("runtime_unavailable", line);
  }

  return null;
}
