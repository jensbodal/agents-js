/**
 * Shared error-aware stream utilities for ACP process communication.
 *
 * Both the client-side `spawnACPAgent` and host-side `createHostACPProcess`
 * need to propagate spawn/exit errors through ReadableStreams that would
 * otherwise silently close. This module provides the common infrastructure.
 */
import type { ChildProcess } from "node:child_process";

/**
 * Handle for signalling errors into an error-aware readable stream.
 * Attach child-process event handlers that call `signal()` on failure.
 */
export interface ErrorSignal {
  /** Signal an error to all waiting readers. */
  signal(err: Error): void;
  /** Current error, if one has been signalled. */
  readonly error: Error | null;
}

interface ErrorSignalInternal extends ErrorSignal {
  /** Register a listener that fires on the next signal (one-shot). */
  addListener(listener: (err: Error) => void): void;
}

/**
 * Create an error signal that can be shared between event handlers and
 * an error-aware ReadableStream.
 *
 * @param keepFirst If true (default), only the first error is kept.
 */
function createErrorSignal(keepFirst = true): ErrorSignalInternal {
  let currentError: Error | null = null;
  const listeners: Array<(err: Error) => void> = [];

  return {
    signal(err: Error) {
      if (keepFirst && currentError) return;
      currentError = err;
      for (const listener of listeners) {
        listener(err);
      }
      listeners.length = 0;
    },
    get error() {
      return currentError;
    },
    addListener(listener: (err: Error) => void) {
      listeners.push(listener);
    },
  };
}

export interface ErrorAwareStreamOptions<T> {
  /**
   * The reader to wrap. Typed loosely to avoid conflicts between
   * Bun/Node/DOM stream type definitions. The output ReadableStream
   * is typed via the generic T parameter.
   */
  reader: {
    read(): Promise<{ done: boolean; value?: T }>;
    cancel(reason?: unknown): Promise<void>;
  };
  /** The child process whose events drive the error signal. */
  child: ChildProcess;
  /** Command name, used for error messages. */
  command: string;
  /**
   * Optional logger called when an error is signalled.
   * If omitted, errors are only propagated through the stream.
   */
  onError?: (message: string) => void;
  /**
   * When true, yield to the microtask queue after the reader signals
   * `done` before deciding to close cleanly. This lets pending "error"
   * or "close" callbacks run first. Useful when the reader is downstream
   * of a transform that swallows errors (e.g. ndJsonStream).
   *
   * Default: false.
   */
  yieldOnDone?: boolean;
  /**
   * When true, only the first error is kept (subsequent calls to signal
   * are ignored). Default: true.
   */
  keepFirstError?: boolean;
}

/**
 * Wrap a ReadableStreamDefaultReader in an error-aware ReadableStream
 * that propagates child-process spawn/exit errors instead of silently closing.
 *
 * Attaches `error` and `close` event handlers to the child process that
 * feed errors into a shared signal. The returned ReadableStream races
 * between the underlying reader and the error signal on each pull.
 */
export function createErrorAwareReadable<T>(opts: ErrorAwareStreamOptions<T>): ReadableStream<T> {
  const { reader, child, command, onError, yieldOnDone = false, keepFirstError = true } = opts;
  const errSignal = createErrorSignal(keepFirstError);

  function signalAndLog(err: Error) {
    errSignal.signal(err);
    onError?.(err.message);
  }

  child.on("error", (error) => {
    signalAndLog(new Error(`Failed to start agent "${command}": ${error.message}`));
  });

  child.on("close", (code, signal) => {
    if (code !== null && code !== 0) {
      signalAndLog(new Error(`Agent process exited with code ${code}`));
    } else if (signal !== null && signal !== "SIGTERM") {
      signalAndLog(new Error(`Agent process killed by signal ${signal}`));
    }
  });

  return new ReadableStream<T>({
    async pull(controller) {
      // If an error already occurred, reject immediately
      if (errSignal.error) {
        controller.error(errSignal.error);
        return;
      }

      // Race between the next chunk/message and a spawn/exit error
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          if (errSignal.error) {
            reject(errSignal.error);
          } else {
            errSignal.addListener(reject);
          }
        }),
      ]);

      if (result.done) {
        if (yieldOnDone) {
          // Let pending "error" / "close" callbacks run before closing cleanly.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (errSignal.error) {
            controller.error(errSignal.error);
            return;
          }
        }
        controller.close();
      } else {
        controller.enqueue(result.value);
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}
