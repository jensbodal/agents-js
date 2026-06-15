/**
 * A2Canvas gateway assembly — the env-gated board loop.
 *
 * Wires the producer package (mappers + poller + Matrix/Plane fetchers) to the
 * board-host and the `/a2canvas/events` SSE handler, all from gateway env
 * (creds never hard-coded). Mirrors `setupGiteaBridge`'s pattern: returns
 * `null` when disabled (no `MATRIX_ACCESS_TOKEN`), so the gateway only mounts
 * the demo when an operator opts in.
 *
 * Flow once started: `poller → mapper → boardHost.ingest → [reducer owns
 * merge/order] → boardHost.subscribe → /events SSE → viewer`. The board never
 * crosses the wire — only the derived `A2CanvasView`.
 */
import { type A2CanvasBoardHost, createA2CanvasBoardHost } from "@agents-js/a2canvas";
import {
  createMatrixFetcher,
  createPlaneFetcher,
  createPoller,
  type HostRoster,
  type PlaneProjectRef,
} from "@agents-js/a2canvas-producers";
import { createA2CanvasEventsHandler } from "./a2canvas-mount.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface SetupA2CanvasOptions {
  /** Override env-read; defaults to `process.env` at the call site in `main()`. */
  env: Env;
}

export interface A2CanvasSetup {
  /** `GET /a2canvas/events` SSE handler — add to `composeAdditionalFetch`. */
  readonly eventsHandler: (req: Request) => Promise<Response | null>;
  /** Start the poll loop; returns a stop fn. Call after the server is up. */
  readonly start: (intervalMs: number) => () => void;
  /** The board-host (exposed for tests / direct ingest). */
  readonly boardHost: A2CanvasBoardHost;
}

/** Parse `A2CANVAS_HOST_ROSTER` JSON (principal→host); `{}` on absent/invalid. */
export function parseHostRoster(raw: string | undefined): HostRoster {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as HostRoster;
    }
  } catch {
    // fall through to empty
  }
  return {};
}

/** Parse `PLANE_PROJECTS` ("DOT:uuid,AJS:uuid") into refs; `[]` on absent/blank. */
export function parsePlaneProjects(raw: string | undefined): PlaneProjectRef[] {
  if (!raw) return [];
  const refs: PlaneProjectRef[] = [];
  for (const part of raw.split(",")) {
    const [identifier, id] = part.split(":").map((s) => s.trim());
    if (identifier && id) refs.push({ identifier, id });
  }
  return refs;
}

function parseStateNames(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // fall through
  }
  return {};
}

/**
 * Build the A2Canvas board loop from env, or return `null` when disabled.
 * Matrix is the demo-critical source (multi-agent room → multiple lanes);
 * Plane is the optional bonus state-change lane (wired only when configured).
 */
export function setupA2Canvas(opts: SetupA2CanvasOptions): A2CanvasSetup | null {
  const { env } = opts;
  const accessToken = env.MATRIX_ACCESS_TOKEN;
  const homeserverUrl = env.MATRIX_HOMESERVER_URL;
  const roomId = env.MATRIX_ROOM_ID;
  // Disabled unless the Matrix source is fully configured — it carries the demo.
  if (!accessToken || !homeserverUrl || !roomId) return null;

  const roster = parseHostRoster(env.A2CANVAS_HOST_ROSTER);

  const fetchMatrixEvents = createMatrixFetcher({ homeserverUrl, accessToken, roomId });

  const planeProjects = parsePlaneProjects(env.PLANE_PROJECTS);
  const planeApiKey = env.PLANE_API_KEY;
  const planeBaseUrl = env.PLANE_BASE_URL;
  const planeWorkspace = env.PLANE_WORKSPACE_SLUG;
  const fetchPlaneItems =
    planeApiKey && planeBaseUrl && planeWorkspace && planeProjects.length > 0
      ? createPlaneFetcher({
          baseUrl: planeBaseUrl,
          apiKey: planeApiKey,
          workspaceSlug: planeWorkspace,
          projects: planeProjects,
          stateNames: parseStateNames(env.PLANE_STATE_NAMES),
        })
      : async () => [];

  const boardHost = createA2CanvasBoardHost();
  const poller = createPoller({
    fetchMatrixEvents,
    fetchPlaneItems,
    ingest: boardHost.ingest,
    matrixOpts: { roster, roomId, homeserver: homeserverUrl },
    planeOpts: { roster },
  });
  const eventsHandler = createA2CanvasEventsHandler(boardHost);

  return {
    eventsHandler,
    start: (intervalMs) => poller.start(intervalMs),
    boardHost,
  };
}
