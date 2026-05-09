/**
 * Centralized exit codes for `agents-js` subcommands. Loosely follows
 * Unix `sysexits.h` conventions where they map cleanly. Subcommands
 * import these named constants so help text, tests, and runtime exits
 * stay aligned without scattered magic numbers.
 *
 * Conventions:
 * - `0`  — success.
 * - `1`  — generic error (transport, network, agent-side failure).
 * - `64` — usage error (caller-side argv mistake).
 * - `65` — bad input data (malformed payload from a peer).
 * - `70` — protocol contamination (e.g. ACP stdout poisoned with
 *          non-ndJSON bytes before any valid frame).
 * - `71` — auth/elicitation required in a non-interactive flow; the
 *          caller must rerun in a mode that supports prompting.
 */

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 64;
export const EXIT_DATAERR = 65;
export const EXIT_PROTOCOL_CONTAMINATION = 70;
export const EXIT_AUTH_REQUIRED = 71;
