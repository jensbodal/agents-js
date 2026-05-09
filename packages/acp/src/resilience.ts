import { type ACPProcess, type ACPProcessOptions, spawnACPAgent } from "./connection.ts";
import { consoleLogSink, type LogSink } from "./log-sink.ts";

export interface ResilientACPProcessOptions extends ACPProcessOptions {
  /** Maximum number of restarts within the sliding window (default: 5) */
  maxRestarts?: number;
  /** Sliding window duration in ms — counter resets after this period of stable running (default: 30000) */
  stableWindowMs?: number;
  /** Base delay for exponential backoff in ms (default: 100) */
  baseDelayMs?: number;
  /** Log sink for error and warning messages (default: consoleLogSink) */
  logSink?: LogSink;
}

export type ExhaustionCallback = (restartCount: number) => void;

export class ResilientACPProcess {
  private acpProcess: ACPProcess;
  private disposed = false;
  private restartCount = 0;
  private windowStart = Date.now();
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private onExhaustionCallback: ExhaustionCallback | null = null;
  private exitHandler: ((code: number | null) => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;
  private errorHandledForCurrentProcess = false;

  private readonly maxRestarts: number;
  private readonly stableWindowMs: number;
  private readonly baseDelayMs: number;
  private readonly logSink: LogSink;

  constructor(private options: ResilientACPProcessOptions = {}) {
    this.maxRestarts = options.maxRestarts ?? 5;
    this.stableWindowMs = options.stableWindowMs ?? 30_000;
    this.baseDelayMs = options.baseDelayMs ?? 100;
    this.logSink = options.logSink ?? consoleLogSink;
    this.acpProcess = spawnACPAgent(this.options);
    this.monitor();
  }

  get stream() {
    return this.acpProcess.stream;
  }

  get process() {
    return this.acpProcess.process;
  }

  /** Register a callback that fires when restart retries are exhausted. */
  onExhaustion(cb: ExhaustionCallback): void {
    this.onExhaustionCallback = cb;
  }

  private monitor() {
    this.startStableTimer();

    this.errorHandledForCurrentProcess = false;

    this.errorHandler = (err: Error) => {
      if (this.disposed) return;
      this.errorHandledForCurrentProcess = true;

      const isENOENT = "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
      if (isENOENT) {
        this.logSink.error("[ACP:resilience] Command not found (ENOENT). Exhausting immediately.");
        this.clearTimers();
        this.onExhaustionCallback?.(0);
        return;
      }
      // Other errors: let exit handler deal with restart
    };
    this.acpProcess.process.on("error", this.errorHandler);

    this.exitHandler = (code) => {
      if (this.disposed) return;
      if (this.errorHandledForCurrentProcess) return; // Already handled by error listener

      // Clean exit (code 0) — intentional shutdown, do not restart.
      if (code === 0) {
        this.clearTimers();
        return;
      }

      // Check sliding window: if we're outside the window, reset the counter.
      const now = Date.now();
      if (now - this.windowStart >= this.stableWindowMs) {
        this.restartCount = 0;
        this.windowStart = now;
      }

      this.restartCount++;

      if (this.restartCount > this.maxRestarts) {
        this.logSink.error(
          `[ACP:resilience] Process exhausted ${this.maxRestarts} restarts within ${this.stableWindowMs}ms window. Giving up.`,
        );
        this.clearTimers();
        if (this.onExhaustionCallback) {
          try {
            this.onExhaustionCallback(this.restartCount - 1);
          } catch (err) {
            this.logSink.error(
              `[ACP:resilience] onExhaustion callback threw: ${(err as Error).message}`,
            );
          }
        }
        return;
      }

      const delay = this.baseDelayMs * 2 ** (this.restartCount - 1);
      this.logSink.warn(
        `[ACP:resilience] Process exited with code ${code}. Restart ${this.restartCount}/${this.maxRestarts} in ${delay}ms...`,
      );

      this.backoffTimer = setTimeout(() => {
        if (this.disposed) return;
        this.performRestart();
      }, delay);
    };
    this.acpProcess.process.on("exit", this.exitHandler);

    // A very short-lived child can exit before these listeners are attached.
    // If that happened, replay the exit path once from the observable exitCode.
    const observedExitCode = this.acpProcess.process.exitCode;
    if (observedExitCode !== null) {
      const exitHandler = this.exitHandler;
      queueMicrotask(() => {
        if (this.exitHandler === exitHandler) {
          exitHandler?.(observedExitCode);
        }
      });
    }
  }

  private startStableTimer() {
    this.clearStableTimer();
    // Capture the current child so the timer is bound to *this* process.
    // If the child has already exited by the time the timer fires (e.g. the
    // exit and the timer race in the same tick at the window boundary), skip
    // the reset — otherwise the about-to-run exit handler would see a freshly
    // zeroed counter and allow one extra restart beyond `maxRestarts`.
    const child = this.acpProcess.process;
    this.stableTimer = setTimeout(() => {
      if (this.disposed) return;
      if (child !== this.acpProcess.process) return;
      if (child.exitCode !== null || child.signalCode !== null) return;
      // Process has been running stably for the full window — reset counters.
      this.restartCount = 0;
      this.windowStart = Date.now();
    }, this.stableWindowMs);
  }

  private clearStableTimer() {
    if (this.stableTimer !== null) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private clearTimers() {
    this.clearStableTimer();
    if (this.backoffTimer !== null) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
  }

  private removeExitHandler() {
    if (this.errorHandler) {
      this.acpProcess.process.removeListener("error", this.errorHandler);
      this.errorHandler = null;
    }
    if (this.exitHandler) {
      this.acpProcess.process.removeListener("exit", this.exitHandler);
      this.exitHandler = null;
    }
  }

  private performRestart() {
    this.removeExitHandler();
    this.acpProcess.kill();
    this.acpProcess = spawnACPAgent(this.options);
    this.monitor();
  }

  /** Manually trigger a restart, bypassing backoff and retry limits. */
  restart() {
    if (this.disposed) return;
    this.performRestart();
  }

  /** Stop monitoring, kill the process, and clean up all timers. */
  destroy() {
    this.disposed = true;
    this.clearTimers();
    this.removeExitHandler();
    this.acpProcess.kill();
  }
}
