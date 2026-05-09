/**
 * Shared scaffolding for in-repo "wrapper" ACP binaries (pi-acp, droid-acp).
 *
 * A wrapper binary speaks ACP on its own stdio and spawns a non-ACP child
 * process per session/turn, translating between the child's native protocol
 * and ACP `session/update` notifications. This factory owns the parts that
 * are identical across every wrapper:
 *
 *   - Adapter-flag parsing (`--help`/`-h`, `--version`/`-v`); everything
 *     else falls through to `forwardedArgs` and is the wrapper's business.
 *   - The NDJSON stdio stream and the `AgentSideConnection` that drives it.
 *   - Signal-driven shutdown with a fixed grace period.
 *
 * Wrappers supply only the bits that vary: a name, a version, help text,
 * and a `createAgent(connection, forwardedArgs)` that returns an Agent.
 */
import { Readable, Writable } from "node:stream";
import {
  type Agent,
  AgentSideConnection,
  ndJsonStream,
  type Stream,
} from "@agentclientprotocol/sdk";

export interface AcpWrapperBinarySpec {
  /** Binary name printed in `--help` and `--version` (e.g. `"pi-acp"`). */
  name: string;
  /** Adapter version printed by `--version`. */
  version: string;
  /** Body printed by `--help`, prefixed with `${name} — `. */
  helpText: string;
  /**
   * Construct the ACP `Agent` for this connection. `forwardedArgs` is every
   * argv entry that wasn't an adapter-owned flag; wrappers thread it into
   * the spawned child (e.g. `pi --mode rpc <forwardedArgs>`).
   */
  createAgent: (connection: AgentSideConnection, forwardedArgs: readonly string[]) => Agent;
}

interface ParsedArgs {
  help: boolean;
  version: boolean;
  forwarded: string[];
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const forwarded: string[] = [];
  let help = false;
  let version = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      version = true;
      continue;
    }
    forwarded.push(arg);
  }
  return { help, version, forwarded };
}

/**
 * Run an in-repo wrapper ACP binary. Returns once `--help`/`--version` exit
 * paths fire; otherwise resolves immediately after the `AgentSideConnection`
 * is wired up — the connection keeps the process alive via its internal
 * reader on stdin.
 */
export async function runAcpWrapperBinary(spec: AcpWrapperBinarySpec): Promise<void> {
  const { help, version, forwarded } = parseArgs(process.argv.slice(2));
  if (help) {
    process.stdout.write(`${spec.name} — ${spec.helpText}`);
    process.exit(0);
  }
  if (version) {
    process.stdout.write(`${spec.name} ${spec.version}\n`);
    process.exit(0);
  }

  const stream: Stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  );

  // The constructed connection is intentionally unreferenced — the
  // AgentSideConnection keeps itself alive through its internal reader on
  // `stream.readable`, and the wiring closure captures everything else.
  void new AgentSideConnection((conn) => spec.createAgent(conn, forwarded), stream);

  // Forward shutdown signals via normal process-group propagation; if the
  // ACP client doesn't drain stdio in time, fall back to a hard exit.
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) {
    process.once(signal, () => {
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}
